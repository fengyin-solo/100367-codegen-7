import { listRows, saveAll, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'
import { createZip, textEntry, type ZipEntry } from '@/utils/zip'

// 装备共享借用编排的本地业务服务：页面只负责渲染，编排、冲突测算、落库事务都在这里。
//
// 器材冲突处理规则（本实现的决定）：
//   1. 同装备类型、同规格型号的「可用」器材优先，本林场器材优先、购入早的先用；
//   2. 数量不足时，同装备类型、同购入批次（购入日期相同）且没有检修记录（最近检修日为空）
//      的可用器材可以跨规格代用，记为「批次兼容」；有检修记录的器材只允许精确匹配；
//   3. 仍有缺口则记为器材冲突，编排可以保存为待确认，但确认落库会被拒绝并整体回退。
//
// 保管林场冲突：器材保管林场与队伍所属林场不一致时不拦截，记为跨场调拨提示，
//   并在调拨台账里以「跨场调拨」类型落库。

export type SequenceItem = {
  装备类型: string
  规格型号: string
  数量: number
}

export type AllocationUnit = {
  id: number
  装备编号: string
  装备名称: string
  规格型号: string
  保管林场: string
  匹配方式: '精确匹配' | '批次兼容'
}

export type AllocationLine = {
  item: SequenceItem
  units: AllocationUnit[]
  shortage: number
  farmConflicts: string[]
}

export type AllocationPreview = {
  lines: AllocationLine[]
  farmConflicts: string[]
  shortageTotal: number
  ready: boolean
  teamFound: boolean
  teamFarm: string
}

export type BorrowResult = ActionResult & { planId?: number }

export type ImportResult = ActionResult & { imported: number; errors: string[] }

export type DraftInput = {
  id?: number
  出动任务: string
  扑火队伍: string
  items: SequenceItem[]
}

export type TeamOption = { 队伍名称: string; 所属林场: string; 状态: string }

// 归队提醒阈值：确认出动超过该小时数仍未核销，就在页面上提醒。
export const REMIND_AFTER_HOURS = 24

// 附件上限：localStorage 容量有限，超过就拒绝登记。
const ATTACHMENT_LIMIT = 512 * 1024

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function newToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `TK-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextNo(rows: EntryRow[], field: string, prefix: string): string {
  const max = rows.reduce((acc, row) => {
    const text = String(row[field] ?? '')
    const match = text.match(new RegExp(`^${prefix}-(\\d+)$`))
    return match ? Math.max(acc, Number(match[1])) : acc
  }, 0)
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

function hasNoMaintenance(row: EntryRow): boolean {
  const text = String(row['最近检修日'] ?? '').trim()
  return text === '' || text === '无'
}

export function parseSequence(raw: unknown): SequenceItem[] {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed
      .map((item) => {
        const record = item as Record<string, unknown>
        return {
          装备类型: String(record['装备类型'] ?? ''),
          规格型号: String(record['规格型号'] ?? ''),
          数量: Math.max(0, Math.floor(Number(record['数量']) || 0)),
        }
      })
      .filter((item) => item.装备类型 !== '' && item.数量 > 0)
  } catch {
    return []
  }
}

export function formatSequence(raw: unknown): string {
  const items = parseSequence(raw)
  if (!items.length) {
    return '—'
  }
  return items.map((item) => `${item.装备类型} ${item.规格型号} ×${item.数量}`).join('；')
}

export function listTeams(): TeamOption[] {
  return listRows('fireteam').map((row) => ({
    队伍名称: String(row['队伍名称'] ?? ''),
    所属林场: String(row['所属林场'] ?? ''),
    状态: String(row.status ?? ''),
  }))
}

export function equipmentCatalog(): { types: string[]; modelsByType: Record<string, string[]> } {
  const modelsByType: Record<string, string[]> = {}
  for (const row of listRows('equipment')) {
    const type = String(row['装备类型'] ?? '')
    const model = String(row['规格型号'] ?? '')
    if (!type) {
      continue
    }
    if (!modelsByType[type]) {
      modelsByType[type] = []
    }
    if (model && !modelsByType[type].includes(model)) {
      modelsByType[type].push(model)
    }
  }
  return { types: Object.keys(modelsByType).sort(), modelsByType }
}

export function dispatchTaskOptions(): string[] {
  return listRows('firereport').map((row) =>
    `${row['报告编号'] ?? ''} ${row['起火地点'] ?? ''}`.trim(),
  )
}

function teamFarmOf(teamName: string): string | null {
  const team = listRows('fireteam').find((row) => String(row['队伍名称']) === teamName)
  return team ? String(team['所属林场'] ?? '') : null
}

// 领用序列是排了序的：前面的序列项先挑器材，后面的只能用剩下的。
function allocate(
  items: SequenceItem[],
  equipmentRows: EntryRow[],
  teamFarm: string,
): AllocationLine[] {
  const used = new Set<number>()
  const byFarmThenBatch = (a: EntryRow, b: EntryRow) => {
    const ownA = a['保管林场'] === teamFarm ? 0 : 1
    const ownB = b['保管林场'] === teamFarm ? 0 : 1
    if (ownA !== ownB) {
      return ownA - ownB
    }
    const dateOrder = String(a['购入日期']).localeCompare(String(b['购入日期']))
    return dateOrder !== 0 ? dateOrder : Number(a.id) - Number(b.id)
  }

  return items.map((item) => {
    const need = Math.max(0, Math.floor(item.数量))
    const available = equipmentRows.filter(
      (row) =>
        String(row.status) === '可用' &&
        String(row['装备类型']) === item.装备类型 &&
        !used.has(Number(row.id)),
    )
    const exact = available
      .filter((row) => String(row['规格型号']) === item.规格型号)
      .sort(byFarmThenBatch)
    const picked: { row: EntryRow; 匹配方式: AllocationUnit['匹配方式'] }[] = exact
      .slice(0, need)
      .map((row) => ({ row, 匹配方式: '精确匹配' }))
    picked.forEach(({ row }) => used.add(Number(row.id)))

    let shortage = need - picked.length
    if (shortage > 0) {
      // 批次锚点：该规格型号器材（不分状态）出现在哪些购入批次，同批次无检修记录的器材才兼容。
      const anchorBatches = new Set(
        equipmentRows
          .filter(
            (row) =>
              String(row['装备类型']) === item.装备类型 &&
              String(row['规格型号']) === item.规格型号,
          )
          .map((row) => String(row['购入日期'])),
      )
      const substitutes = available
        .filter(
          (row) =>
            !used.has(Number(row.id)) &&
            String(row['规格型号']) !== item.规格型号 &&
            hasNoMaintenance(row) &&
            anchorBatches.has(String(row['购入日期'])),
        )
        .sort(byFarmThenBatch)
      for (const row of substitutes.slice(0, shortage)) {
        picked.push({ row, 匹配方式: '批次兼容' })
        used.add(Number(row.id))
        shortage -= 1
      }
    }

    const units: AllocationUnit[] = picked.map(({ row, 匹配方式 }) => ({
      id: Number(row.id),
      装备编号: String(row['装备编号'] ?? ''),
      装备名称: String(row['装备名称'] ?? ''),
      规格型号: String(row['规格型号'] ?? ''),
      保管林场: String(row['保管林场'] ?? ''),
      匹配方式,
    }))
    const farmConflicts = units
      .filter((unit) => teamFarm !== '' && unit.保管林场 !== teamFarm)
      .map(
        (unit) =>
          `${unit.装备编号}保管于${unit.保管林场}，需跨场调拨至${teamFarm}`,
      )
    return { item, units, shortage, farmConflicts }
  })
}

export function previewAllocation(items: SequenceItem[], teamName: string): AllocationPreview {
  const teamFarm = teamFarmOf(teamName)
  const lines = allocate(items, listRows('equipment'), teamFarm ?? '')
  const farmConflicts = lines.flatMap((line) => line.farmConflicts)
  const shortageTotal = lines.reduce((sum, line) => sum + line.shortage, 0)
  return {
    lines,
    farmConflicts,
    shortageTotal,
    ready: teamFarm !== null && shortageTotal === 0 && items.length > 0,
    teamFound: teamFarm !== null,
    teamFarm: teamFarm ?? '',
  }
}

function conflictSummary(preview: AllocationPreview): string {
  const parts: string[] = []
  if (preview.shortageTotal > 0) {
    parts.push(`器材冲突：缺口 ${preview.shortageTotal} 台`)
  }
  if (preview.farmConflicts.length > 0) {
    parts.push(...preview.farmConflicts)
  }
  return parts.join('；')
}

export function listPlans(): EntryRow[] {
  return [...listRows('borrowplan')].sort((a, b) => Number(b.id) - Number(a.id))
}

export function listDispatch(): EntryRow[] {
  return [...listRows('dispatchlist')].sort((a, b) => Number(b.id) - Number(a.id))
}

export function listLedger(): EntryRow[] {
  return [...listRows('transferledger')].sort((a, b) => Number(b.id) - Number(a.id))
}

export function occupiedCount(): number {
  return listRows('equipment').filter((row) => String(row['占用编排'] ?? '') !== '').length
}

export function planHoursSinceConfirm(plan: EntryRow): number | null {
  const text = String(plan['确认时间'] ?? '')
  if (!text) {
    return null
  }
  const at = new Date(text.replace(' ', 'T'))
  if (Number.isNaN(at.getTime())) {
    return null
  }
  return (Date.now() - at.getTime()) / 3_600_000
}

export function needsReturnReminder(plan: EntryRow): boolean {
  if (String(plan.status) !== '已确认') {
    return false
  }
  const hours = planHoursSinceConfirm(plan)
  return hours !== null && hours >= REMIND_AFTER_HOURS
}

function validateDraft(input: DraftInput): string | null {
  if (input.出动任务.trim() === '') {
    return '出动任务不能为空'
  }
  if (teamFarmOf(input.扑火队伍) === null) {
    return `扑火队伍「${input.扑火队伍}」不存在`
  }
  if (!input.items.length) {
    return '领用序列不能为空，至少添加一项'
  }
  const catalog = equipmentCatalog()
  for (const item of input.items) {
    if (!catalog.types.includes(item.装备类型)) {
      return `装备类型「${item.装备类型}」不在装备目录里`
    }
    if (!catalog.modelsByType[item.装备类型].includes(item.规格型号)) {
      return `规格型号「${item.规格型号}」不属于${item.装备类型}`
    }
    if (!Number.isInteger(item.数量) || item.数量 < 1) {
      return `${item.装备类型} ${item.规格型号} 的数量必须是不小于 1 的整数`
    }
  }
  return null
}

export function saveDraft(input: DraftInput): BorrowResult {
  const invalid = validateDraft(input)
  if (invalid) {
    return { ok: false, message: invalid }
  }
  const plans = listRows('borrowplan').map(clone)
  const preview = previewAllocation(input.items, input.扑火队伍)
  const summary = conflictSummary(preview)
  const sequence = JSON.stringify(input.items)

  if (input.id !== undefined) {
    const index = plans.findIndex((row) => Number(row.id) === Number(input.id))
    if (index < 0) {
      return { ok: false, message: '没有找到要修改的借用编排单' }
    }
    if (String(plans[index].status) !== '待确认') {
      return { ok: false, message: '只有待确认的编排可以修改' }
    }
    plans[index] = {
      ...plans[index],
      出动任务: input.出动任务.trim(),
      扑火队伍: input.扑火队伍,
      领用序列: sequence,
      冲突提示: summary,
      提交令牌: newToken(), // 内容变了就是新的提交，旧令牌作废
    }
    saveRows('borrowplan', plans)
    return { ok: true, message: `借用编排 ${plans[index]['编排编号']} 已更新`, planId: Number(input.id) }
  }

  const id = nextId(plans)
  const planNo = nextNo(plans, '编排编号', 'BORR')
  plans.push({
    id,
    status: '待确认',
    pending: true,
    abnormal: false,
    编排编号: planNo,
    出动任务: input.出动任务.trim(),
    扑火队伍: input.扑火队伍,
    领用序列: sequence,
    冲突提示: summary,
    提交令牌: newToken(),
    确认时间: '',
    编排状态: '待确认',
    附件名称: '',
  })
  saveRows('borrowplan', plans)
  return { ok: true, message: `借用编排 ${planNo} 已保存为待确认`, planId: id }
}

// 确认落库：出动清单、装备状态、调拨台账、编排单、队伍状态同次写入；
// 任何一步校验不过都不写库（整体回退）；同一提交令牌重复提交只生效一次。
export function confirmPlan(planId: number, token: string): ActionResult {
  const plans = listRows('borrowplan').map(clone)
  const plan = plans.find((row) => Number(row.id) === planId)
  if (!plan) {
    return { ok: false, message: '没有找到该借用编排单' }
  }
  if (String(plan.status) === '已确认') {
    if (String(plan['提交令牌']) === token) {
      return { ok: true, message: `编排 ${plan['编排编号']} 重复提交已被忽略，只生效一次` }
    }
    return { ok: false, message: `编排 ${plan['编排编号']} 已确认落库，不能重复提交` }
  }
  if (String(plan.status) !== '待确认') {
    return { ok: false, message: `编排当前状态「${plan.status}」，不能确认` }
  }

  const items = parseSequence(plan['领用序列'])
  if (!items.length) {
    return { ok: false, message: '领用序列为空，无法确认，已整体回退' }
  }
  const teamName = String(plan['扑火队伍'])
  const teams = listRows('fireteam').map(clone)
  const team = teams.find((row) => String(row['队伍名称']) === teamName)
  if (!team) {
    return { ok: false, message: `扑火队伍「${teamName}」不存在，已整体回退` }
  }
  if (['已撤回', '休整中'].includes(String(team.status))) {
    return { ok: false, message: `队伍当前状态「${team.status}」，不能出动，已整体回退` }
  }

  const equipment = listRows('equipment').map(clone)
  const teamFarm = String(team['所属林场'] ?? '')
  const lines = allocate(items, equipment, teamFarm)
  const shortageTotal = lines.reduce((sum, line) => sum + line.shortage, 0)
  if (shortageTotal > 0) {
    return {
      ok: false,
      message: `器材冲突未解决：缺口 ${shortageTotal} 台，请调整领用序列后再确认，已整体回退`,
    }
  }

  const now = nowText()
  const planNo = String(plan['编排编号'])
  const dispatch = listRows('dispatchlist').map(clone)
  const ledger = listRows('transferledger').map(clone)
  const farmConflicts = lines.flatMap((line) => line.farmConflicts)

  let dispatchId = nextId(dispatch)
  let ledgerId = nextId(ledger)
  for (const line of lines) {
    for (const unit of line.units) {
      const target = equipment.find((row) => Number(row.id) === unit.id)
      if (!target || String(target.status) !== '可用') {
        return { ok: false, message: `装备 ${unit.装备编号} 状态已变化，已整体回退` }
      }
      target.status = '已领用'
      target['装备状态'] = '已领用'
      target['占用编排'] = planNo
      target.pending = true
      dispatch.push({
        id: dispatchId,
        status: '已出动',
        pending: true,
        abnormal: false,
        清单编号: `DISP-${String(dispatchId).padStart(4, '0')}`,
        编排编号: planNo,
        扑火队伍: teamName,
        装备编号: unit.装备编号,
        装备名称: unit.装备名称,
        规格型号: unit.规格型号,
        保管林场: unit.保管林场,
        匹配方式: unit.匹配方式,
        出动时间: now,
        清单状态: '已出动',
      })
      dispatchId += 1
      ledger.push({
        id: ledgerId,
        status: '已登记',
        pending: true,
        abnormal: false,
        台账编号: `LEDG-${String(ledgerId).padStart(4, '0')}`,
        编排编号: planNo,
        装备编号: unit.装备编号,
        调出林场: unit.保管林场,
        调入队伍: teamName,
        调拨数量: 1,
        调拨类型: unit.保管林场 === teamFarm ? '同场领用' : '跨场调拨',
        登记时间: now,
        台账状态: '已登记',
      })
      ledgerId += 1
    }
  }

  if (String(team.status) === '在营待命') {
    team.status = '已出动'
    team['出动状态'] = '已出动'
    team.pending = true
  }
  plan.status = '已确认'
  plan['编排状态'] = '已确认'
  plan['确认时间'] = now
  plan['提交令牌'] = token
  plan['冲突提示'] = farmConflicts.join('；')
  plan.pending = true

  try {
    saveAll({
      borrowplan: plans,
      equipment,
      dispatchlist: dispatch,
      transferledger: ledger,
      fireteam: teams,
    })
  } catch {
    return { ok: false, message: '写入本地存储失败，已整体回退，未产生任何台账' }
  }
  const total = lines.reduce((sum, line) => sum + line.units.length, 0)
  const extra = farmConflicts.length > 0 ? `；保管林场冲突 ${farmConflicts.length} 起已记入台账` : ''
  return {
    ok: true,
    message: `编排 ${planNo} 已确认：出动清单 ${total} 条、装备领用 ${total} 台、调拨台账 ${total} 条同次落库${extra}`,
  }
}

export function cancelPlan(planId: number): ActionResult {
  const plans = listRows('borrowplan').map(clone)
  const plan = plans.find((row) => Number(row.id) === planId)
  if (!plan) {
    return { ok: false, message: '没有找到该借用编排单' }
  }
  if (String(plan.status) !== '待确认') {
    return { ok: false, message: '只有待确认的编排可以取消；已确认的请先核销归队' }
  }
  plan.status = '已取消'
  plan['编排状态'] = '已取消'
  plan.pending = false
  saveRows('borrowplan', plans)
  return { ok: true, message: `编排 ${plan['编排编号']} 已取消` }
}

// 核销：释放器材占用、出动清单归队、台账补记归还、队伍撤回，同次落库。
function writeoffInWorkspace(
  ws: {
    borrowplan: EntryRow[]
    equipment: EntryRow[]
    dispatchlist: EntryRow[]
    transferledger: EntryRow[]
    fireteam: EntryRow[]
  },
  plan: EntryRow,
  now: string,
): number {
  const planNo = String(plan['编排编号'])
  const teamName = String(plan['扑火队伍'])
  let released = 0
  for (const row of ws.equipment) {
    if (String(row['占用编排'] ?? '') === planNo) {
      row.status = '可用'
      row['装备状态'] = '可用'
      row['占用编排'] = ''
      row.pending = true
      released += 1
    }
  }
  for (const row of ws.dispatchlist) {
    if (String(row['编排编号']) === planNo && String(row.status) === '已出动') {
      row.status = '已归队'
      row['清单状态'] = '已归队'
      row['归队时间'] = now
      row.pending = false
    }
  }
  let ledgerId = nextId(ws.transferledger)
  const team = ws.fireteam.find((row) => String(row['队伍名称']) === teamName)
  const teamFarm = team ? String(team['所属林场'] ?? '') : ''
  for (const row of ws.transferledger) {
    if (String(row['编排编号']) === planNo && String(row.status) === '已登记') {
      row.status = '已核销'
      row['台账状态'] = '已核销'
      row.pending = false
      ws.transferledger.push({
        id: ledgerId,
        status: '已核销',
        pending: false,
        abnormal: false,
        台账编号: `LEDG-${String(ledgerId).padStart(4, '0')}`,
        编排编号: planNo,
        装备编号: row['装备编号'],
        调出林场: teamFarm,
        调入队伍: String(row['调出林场']),
        调拨数量: row['调拨数量'],
        调拨类型: '归还核销',
        登记时间: now,
        台账状态: '已核销',
      })
      ledgerId += 1
    }
  }
  if (team && ['已出动', '扑救中'].includes(String(team.status))) {
    team.status = '已撤回'
    team['出动状态'] = '已撤回'
  }
  plan.status = '已核销'
  plan['编排状态'] = '已核销'
  plan.pending = false
  return released
}

function loadWorkspace() {
  return {
    borrowplan: listRows('borrowplan').map(clone),
    equipment: listRows('equipment').map(clone),
    dispatchlist: listRows('dispatchlist').map(clone),
    transferledger: listRows('transferledger').map(clone),
    fireteam: listRows('fireteam').map(clone),
  }
}

export function writeoffPlan(planId: number): ActionResult {
  const ws = loadWorkspace()
  const plan = ws.borrowplan.find((row) => Number(row.id) === planId)
  if (!plan) {
    return { ok: false, message: '没有找到该借用编排单' }
  }
  if (String(plan.status) !== '已确认') {
    return { ok: false, message: '只有已确认的编排可以核销归队' }
  }
  const released = writeoffInWorkspace(ws, plan, nowText())
  try {
    saveAll({ ...ws })
  } catch {
    return { ok: false, message: '写入本地存储失败，核销已整体回退' }
  }
  return {
    ok: true,
    message: `编排 ${plan['编排编号']} 已核销：${released} 台装备解除占用，出动清单与调拨台账同次落库`,
  }
}

// 扑火队伍联动：队伍被撤回或转入休整时，自动核销该队伍名下所有已确认的领用占用。
export function releasePlansForTeam(teamName: string): { released: number; planNos: string[] } {
  if (!teamName) {
    return { released: 0, planNos: [] }
  }
  const ws = loadWorkspace()
  const now = nowText()
  const planNos: string[] = []
  for (const plan of ws.borrowplan) {
    if (String(plan.status) === '已确认' && String(plan['扑火队伍']) === teamName) {
      writeoffInWorkspace(ws, plan, now)
      planNos.push(String(plan['编排编号']))
    }
  }
  if (planNos.length > 0) {
    saveAll({ ...ws })
  }
  return { released: planNos.length, planNos }
}

export function attachToPlan(
  planId: number,
  file: { name: string; type: string; size: number; dataUrl: string },
): ActionResult {
  const plans = listRows('borrowplan').map(clone)
  const plan = plans.find((row) => Number(row.id) === planId)
  if (!plan) {
    return { ok: false, message: '没有找到该借用编排单' }
  }
  if (file.size > ATTACHMENT_LIMIT) {
    return { ok: false, message: `附件不能超过 ${ATTACHMENT_LIMIT / 1024}KB（纯前端本地存储限制）` }
  }
  plan['附件名称'] = file.name
  plan['附件类型'] = file.type || 'application/octet-stream'
  plan['附件大小'] = file.size
  plan['附件内容'] = file.dataUrl
  saveRows('borrowplan', plans)
  return { ok: true, message: `附件「${file.name}」已上传到编排 ${plan['编排编号']}` }
}

function csvLine(cells: (string | number)[]): string {
  return cells
    .map((cell) => {
      const text = String(cell ?? '')
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    })
    .join(',')
}

function dataUrlToBytes(dataUrl: string): Uint8Array<ArrayBuffer> | null {
  const match = /^data:.*?;base64,(.*)$/.exec(dataUrl)
  if (!match) {
    return null
  }
  const binary = atob(match[1])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// 打包下载：编排单、出动清单、调拨台账（含已上传附件）打成一个 zip。
export function packagePlan(planId: number): ActionResult {
  const plan = listRows('borrowplan').find((row) => Number(row.id) === planId)
  if (!plan) {
    return { ok: false, message: '没有找到该借用编排单' }
  }
  const planNo = String(plan['编排编号'])
  const items = parseSequence(plan['领用序列'])

  const planLines = [
    csvLine(['编排编号', '出动任务', '扑火队伍', '装备类型', '规格型号', '数量', '编排状态', '确认时间', '提交令牌', '冲突提示']),
    ...items.map((item) =>
      csvLine([
        planNo,
        String(plan['出动任务']),
        String(plan['扑火队伍']),
        item.装备类型,
        item.规格型号,
        item.数量,
        String(plan.status),
        String(plan['确认时间'] ?? ''),
        String(plan['提交令牌'] ?? ''),
        String(plan['冲突提示'] ?? ''),
      ]),
    ),
  ]

  const dispatchRows = listRows('dispatchlist').filter((row) => String(row['编排编号']) === planNo)
  const dispatchLines = [
    csvLine(['清单编号', '编排编号', '扑火队伍', '装备编号', '装备名称', '规格型号', '保管林场', '匹配方式', '出动时间', '清单状态']),
    ...dispatchRows.map((row) =>
      csvLine([
        String(row['清单编号']),
        String(row['编排编号']),
        String(row['扑火队伍']),
        String(row['装备编号']),
        String(row['装备名称']),
        String(row['规格型号']),
        String(row['保管林场']),
        String(row['匹配方式']),
        String(row['出动时间']),
        String(row.status),
      ]),
    ),
  ]

  const ledgerRows = listRows('transferledger').filter((row) => String(row['编排编号']) === planNo)
  const ledgerLines = [
    csvLine(['台账编号', '编排编号', '装备编号', '调出林场', '调入队伍', '调拨数量', '调拨类型', '登记时间', '台账状态']),
    ...ledgerRows.map((row) =>
      csvLine([
        String(row['台账编号']),
        String(row['编排编号']),
        String(row['装备编号']),
        String(row['调出林场']),
        String(row['调入队伍']),
        Number(row['调拨数量']) || 0,
        String(row['调拨类型']),
        String(row['登记时间']),
        String(row.status),
      ]),
    ),
  ]

  const entries: ZipEntry[] = [
    textEntry(`编排单-${planNo}.csv`, `\uFEFF${planLines.join('\n')}`),
    textEntry(`出动清单-${planNo}.csv`, `\uFEFF${dispatchLines.join('\n')}`),
    textEntry(`调拨台账-${planNo}.csv`, `\uFEFF${ledgerLines.join('\n')}`),
  ]
  const attachName = String(plan['附件名称'] ?? '')
  const attachContent = String(plan['附件内容'] ?? '')
  if (attachName && attachContent) {
    const bytes = dataUrlToBytes(attachContent)
    if (bytes) {
      entries.push({ name: `附件/${attachName}`, data: bytes })
    }
  }

  downloadBlob(`借用编排-${planNo}-打包.zip`, createZip(entries))
  return {
    ok: true,
    message: `编排 ${planNo} 已打包下载：编排单、出动清单 ${dispatchRows.length} 条、调拨台账 ${ledgerRows.length} 条`,
  }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') {
        i += 1
      }
      row.push(field)
      field = ''
      if (row.some((cell) => cell.trim() !== '')) {
        rows.push(row)
      }
      row = []
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (row.some((cell) => cell.trim() !== '')) {
      rows.push(row)
    }
  }
  return rows
}

type ImportedDraft = { 出动任务: string; 扑火队伍: string; items: SequenceItem[] }

function draftsFromJson(text: string): ImportedDraft[] {
  const parsed = JSON.parse(text) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error('JSON 顶层必须是数组')
  }
  return parsed.map((record) => {
    const item = record as Record<string, unknown>
    const rawItems = (item['序列'] ?? item['领用序列'] ?? []) as unknown
    const items: SequenceItem[] = Array.isArray(rawItems)
      ? rawItems.map((raw) => {
          const entry = raw as Record<string, unknown>
          return {
            装备类型: String(entry['装备类型'] ?? ''),
            规格型号: String(entry['规格型号'] ?? ''),
            数量: Math.floor(Number(entry['数量']) || 0),
          }
        })
      : []
    return {
      出动任务: String(item['出动任务'] ?? ''),
      扑火队伍: String(item['扑火队伍'] ?? ''),
      items,
    }
  })
}

// CSV 列：出动任务,扑火队伍,装备类型,规格型号,数量；同任务同队伍的连续行合并成一张编排。
function draftsFromCsv(text: string): ImportedDraft[] {
  const rows = parseCsv(text)
  if (rows.length > 0 && rows[0][0]?.trim() === '出动任务') {
    rows.shift()
  }
  const drafts: ImportedDraft[] = []
  const byKey = new Map<string, ImportedDraft>()
  for (const row of rows) {
    const [task = '', team = '', type = '', model = '', qty = ''] = row.map((cell) => cell.trim())
    const key = `${task}|${team}`
    let draft = byKey.get(key)
    if (!draft) {
      draft = { 出动任务: task, 扑火队伍: team, items: [] }
      byKey.set(key, draft)
      drafts.push(draft)
    }
    draft.items.push({ 装备类型: type, 规格型号: model, 数量: Math.floor(Number(qty) || 0) })
  }
  return drafts
}

// 文件导入：CSV / JSON 批量生成待确认编排；合法的一次落库，不合法的逐条报错。
export function importPlans(filename: string, text: string): ImportResult {
  let drafts: ImportedDraft[]
  try {
    drafts = filename.toLowerCase().endsWith('.json') ? draftsFromJson(text) : draftsFromCsv(text)
  } catch (error) {
    return {
      ok: false,
      message: `文件解析失败：${error instanceof Error ? error.message : '格式不正确'}`,
      imported: 0,
      errors: [],
    }
  }
  if (!drafts.length) {
    return { ok: false, message: '文件里没有可导入的编排内容', imported: 0, errors: [] }
  }

  const errors: string[] = []
  const valid: ImportedDraft[] = []
  drafts.forEach((draft, index) => {
    const invalid = validateDraft({ 出动任务: draft.出动任务, 扑火队伍: draft.扑火队伍, items: draft.items })
    if (invalid) {
      errors.push(`第 ${index + 1} 张编排：${invalid}`)
    } else {
      valid.push(draft)
    }
  })
  if (!valid.length) {
    return { ok: false, message: '没有通过校验的编排，未导入', imported: 0, errors }
  }

  const plans = listRows('borrowplan').map(clone)
  let id = nextId(plans)
  for (const draft of valid) {
    const planNo = nextNo(plans, '编排编号', 'BORR')
    const preview = previewAllocation(draft.items, draft.扑火队伍)
    plans.push({
      id,
      status: '待确认',
      pending: true,
      abnormal: false,
      编排编号: planNo,
      出动任务: draft.出动任务.trim(),
      扑火队伍: draft.扑火队伍,
      领用序列: JSON.stringify(draft.items),
      冲突提示: conflictSummary(preview),
      提交令牌: newToken(),
      确认时间: '',
      编排状态: '待确认',
      附件名称: '',
    })
    id += 1
  }
  saveRows('borrowplan', plans)
  const suffix = errors.length > 0 ? `，${errors.length} 张未通过校验` : ''
  return { ok: true, message: `已导入 ${valid.length} 张待确认编排${suffix}`, imported: valid.length, errors }
}
