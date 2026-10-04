import { listRows, saveModules, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'
import { downloadBlob, zipFiles } from '@/utils/zip'

// 共享借用编排的领域逻辑：领用序列编排、冲突检测、确认落库、联动核销、导入导出。
// 页面不直接改数据，统一走这里和 local-service.ts。

export type BorrowLine = {
  equipmentId: number
  装备编号: string
  装备名称: string
  规格型号: string
  保管林场: string
  替代: boolean // 批次兼容替代：无检修记录、同购入批次的同类型装备顶上
  跨场: boolean // 保管林场冲突：装备保管林场与队伍所属林场不一致
}

export type ConflictReport = {
  crossFarm: string[]
  substituted: string[]
  occupied: string[]
  shortage: number
}

export type PlanInput = {
  出动任务: string
  扑火队伍: string
  装备类型: string
  规格型号: string
  需求数量: number
}

const PLAN_KEY = 'borrowplan'
const TEAM_KEY = 'fireteam'
const EQUIPMENT_KEY = 'equipment'
const DISPATCH_KEY = 'dispatch'
const ALLOCATION_KEY = 'allocation'

const CONFIRMABLE = ['草稿', '待确认']

// ---------- 基础读取 ----------

export function plans(): EntryRow[] {
  return listRows(PLAN_KEY)
}

export function teams(): EntryRow[] {
  return listRows(TEAM_KEY)
}

export function equipmentRows(): EntryRow[] {
  return listRows(EQUIPMENT_KEY)
}

export function teamByName(name: string): EntryRow | undefined {
  return teams().find((row) => String(row['队伍名称']) === name)
}

export function equipmentTypes(): string[] {
  return [...new Set(equipmentRows().map((row) => String(row['装备类型'] ?? '')))].filter(Boolean)
}

export function specsOfType(type: string): string[] {
  return [
    ...new Set(
      equipmentRows()
        .filter((row) => String(row['装备类型']) === type)
        .map((row) => String(row['规格型号'] ?? '')),
    ),
  ].filter(Boolean)
}

export function dispatchTasks(): string[] {
  return listRows('firereport').map((row) =>
    `${row['报告编号'] ?? ''} ${row['起火地点'] ?? ''}`.trim(),
  )
}

// ---------- 序列与冲突 ----------

export function parsePlanLines(plan: EntryRow): BorrowLine[] {
  try {
    const parsed = JSON.parse(String(plan['领用序列'] || '[]')) as BorrowLine[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// 历史没有检修记录的装备按购入批次（购入年份）兼容：同类型、无检修记录、同批次即可顶替。
function hasMaintenance(row: EntryRow): boolean {
  const day = String(row['最近检修日'] ?? '').trim()
  return day !== '' && day !== '无'
}

function purchaseBatch(row: EntryRow): string {
  return String(row['购入日期'] ?? '').slice(0, 4)
}

function toLine(row: EntryRow, 替代: boolean, teamFarm: string): BorrowLine {
  const farm = String(row['保管林场'] ?? '')
  return {
    equipmentId: Number(row.id),
    装备编号: String(row['装备编号'] ?? ''),
    装备名称: String(row['装备名称'] ?? ''),
    规格型号: String(row['规格型号'] ?? ''),
    保管林场: farm,
    替代,
    跨场: teamFarm !== '' && farm !== teamFarm,
  }
}

function describeLines(lines: BorrowLine[], teamFarm: string, report: ConflictReport): ConflictReport {
  return {
    ...report,
    crossFarm: lines
      .filter((line) => line.跨场)
      .map((line) => `${line.装备编号} 保管于${line.保管林场}，队伍属${teamFarm}，需跨场调拨`),
    substituted: lines
      .filter((line) => line.替代)
      .map((line) => `${line.装备编号}（${line.规格型号}）按购入批次兼容替代`),
  }
}

export function conflictSummary(report: ConflictReport): string {
  const parts: string[] = []
  if (report.crossFarm.length > 0) parts.push(`保管林场冲突${report.crossFarm.length}项`)
  if (report.substituted.length > 0) parts.push(`批次兼容替代${report.substituted.length}项`)
  if (report.occupied.length > 0) parts.push(`器材占用${report.occupied.length}台`)
  if (report.shortage > 0) parts.push(`缺口${report.shortage}台`)
  return parts.length > 0 ? parts.join('；') : '无冲突'
}

// 生成领用序列：先取规格型号完全一致的可用装备；不足时用同类型、无检修记录、
// 同购入批次的装备兼容替代；再不足记缺口，确认时整体拦截。
export function buildSequence(input: PlanInput): { lines: BorrowLine[]; report: ConflictReport } {
  const teamFarm = String(teamByName(input.扑火队伍)?.['所属林场'] ?? '')
  const sameType = equipmentRows().filter((row) => String(row['装备类型']) === input.装备类型)
  const sameSpec = sameType.filter((row) => String(row['规格型号']) === input.规格型号)
  const available = sameSpec.filter((row) => String(row.status) === '可用')
  const occupied = sameSpec.filter((row) => String(row.status) !== '可用')
  const batchSource = available[0] ?? sameSpec[0]
  const batch = batchSource ? purchaseBatch(batchSource) : ''

  const need = Math.max(0, Math.floor(input.需求数量))
  const lines: BorrowLine[] = []
  for (const row of available) {
    if (lines.length >= need) break
    lines.push(toLine(row, false, teamFarm))
  }
  if (lines.length < need && batch !== '') {
    const substitutes = sameType.filter(
      (row) =>
        String(row.status) === '可用' &&
        String(row['规格型号']) !== input.规格型号 &&
        !hasMaintenance(row) &&
        purchaseBatch(row) === batch &&
        !lines.some((line) => line.equipmentId === Number(row.id)),
    )
    for (const row of substitutes) {
      if (lines.length >= need) break
      lines.push(toLine(row, true, teamFarm))
    }
  }

  const report = describeLines(lines, teamFarm, {
    crossFarm: [],
    substituted: [],
    occupied: occupied.map((row) => `${row['装备编号']}（${row.status}）`),
    shortage: Math.max(0, need - lines.length),
  })
  return { lines, report }
}

// 依据当前序列重算冲突提示（手动调整序列后调用）。
export function describePlan(plan: EntryRow): ConflictReport {
  const lines = parsePlanLines(plan)
  const teamFarm = String(teamByName(String(plan['扑火队伍']))?.['所属林场'] ?? '')
  const sameSpec = equipmentRows().filter(
    (row) =>
      String(row['装备类型']) === String(plan['装备类型']) &&
      String(row['规格型号']) === String(plan['规格型号']),
  )
  const occupied = sameSpec.filter((row) => String(row.status) !== '可用')
  const need = Math.max(0, Math.floor(Number(plan['需求数量']) || 0))
  return describeLines(lines, teamFarm, {
    crossFarm: [],
    substituted: [],
    occupied: occupied.map((row) => `${row['装备编号']}（${row.status}）`),
    shortage: Math.max(0, need - lines.length),
  })
}

// ---------- 编号与令牌 ----------

function codeGenerator(existing: string[], prefix: string): () => string {
  let max = 0
  for (const code of existing) {
    const match = String(code).match(/(\d+)$/)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return () => {
    max += 1
    return `${prefix}-${String(max).padStart(4, '0')}`
  }
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function newToken(): string {
  return `TOK-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function nowText(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

// ---------- 编排增改 ----------

function findDuplicatePlan(input: PlanInput): EntryRow | undefined {
  return plans().find(
    (row) =>
      String(row['出动任务']) === input.出动任务 &&
      String(row['扑火队伍']) === input.扑火队伍 &&
      String(row['装备类型']) === input.装备类型 &&
      String(row['规格型号']) === input.规格型号 &&
      String(row.status) !== '已取消',
  )
}

export function createBorrowPlan(input: PlanInput): ActionResult & { id?: number } {
  if (input.出动任务.trim() === '') {
    return { ok: false, message: '出动任务不能为空' }
  }
  if (!teamByName(input.扑火队伍)) {
    return { ok: false, message: `扑火队伍「${input.扑火队伍}」不存在` }
  }
  if (!equipmentTypes().includes(input.装备类型)) {
    return { ok: false, message: `装备类型「${input.装备类型}」没有登记` }
  }
  if (!Number.isFinite(input.需求数量) || input.需求数量 < 1) {
    return { ok: false, message: '需求数量至少为 1' }
  }
  if (findDuplicatePlan(input)) {
    return { ok: false, message: '相同任务、队伍、类型与规格的编排已存在，重复提交只生效一次' }
  }
  const { lines, report } = buildSequence(input)
  const farms = [...new Set(lines.map((line) => line.保管林场))].join('、')
  const all = plans()
  const row: EntryRow = {
    id: nextId(all),
    status: '草稿',
    pending: true,
    abnormal: report.shortage > 0,
    编排编号: codeGenerator(all.map((item) => String(item['编排编号'] ?? '')), 'BORR')(),
    出动任务: input.出动任务.trim(),
    扑火队伍: input.扑火队伍,
    装备类型: input.装备类型,
    规格型号: input.规格型号,
    需求数量: Math.floor(input.需求数量),
    保管林场: farms,
    领用序列: JSON.stringify(lines),
    冲突提示: conflictSummary(report),
    提交令牌: '',
    附件: '',
    附件数据: '',
    编排状态: '草稿',
  }
  saveRows(PLAN_KEY, [...all, row])
  return { ok: true, message: `编排草稿 ${row['编排编号']} 已生成：${conflictSummary(report)}`, id: row.id }
}

// 重新检测：按当前装备台账重建序列，覆盖手动调整。
export function rebuildSequence(planId: number): ActionResult {
  const all = plans()
  const index = all.findIndex((row) => Number(row.id) === planId)
  if (index < 0) return { ok: false, message: '编排单不存在' }
  const plan = all[index]
  if (!CONFIRMABLE.includes(String(plan.status))) {
    return { ok: false, message: '只有草稿/待确认的编排才能重建序列' }
  }
  const { lines, report } = buildSequence({
    出动任务: String(plan['出动任务']),
    扑火队伍: String(plan['扑火队伍']),
    装备类型: String(plan['装备类型']),
    规格型号: String(plan['规格型号']),
    需求数量: Number(plan['需求数量']) || 0,
  })
  const next = [...all]
  next[index] = {
    ...plan,
    保管林场: [...new Set(lines.map((line) => line.保管林场))].join('、'),
    领用序列: JSON.stringify(lines),
    冲突提示: conflictSummary(report),
    abnormal: report.shortage > 0,
  }
  saveRows(PLAN_KEY, next)
  return { ok: true, message: `已重新检测冲突：${conflictSummary(report)}` }
}

// 手动调整后的序列落库（上移/下移/移除），并重算冲突提示。
export function updatePlanLines(planId: number, lines: BorrowLine[]): ActionResult {
  const all = plans()
  const index = all.findIndex((row) => Number(row.id) === planId)
  if (index < 0) return { ok: false, message: '编排单不存在' }
  const plan = all[index]
  if (!CONFIRMABLE.includes(String(plan.status))) {
    return { ok: false, message: '只有草稿/待确认的编排才能调整序列' }
  }
  const next = [...all]
  const updated: EntryRow = {
    ...plan,
    保管林场: [...new Set(lines.map((line) => line.保管林场))].join('、'),
    领用序列: JSON.stringify(lines),
  }
  updated['冲突提示'] = conflictSummary(describePlan(updated))
  next[index] = updated
  saveRows(PLAN_KEY, next)
  return { ok: true, message: '领用序列已调整' }
}

// ---------- 确认落库（事务） ----------

type Workspace = {
  equipment: EntryRow[]
  fireteam: EntryRow[]
  dispatch: EntryRow[]
  allocation: EntryRow[]
  borrowplan: EntryRow[]
}

function loadWorkspace(): Workspace {
  const clone = (rows: EntryRow[]) => rows.map((row) => ({ ...row }))
  return {
    equipment: clone(equipmentRows()),
    fireteam: clone(teams()),
    dispatch: clone(listRows(DISPATCH_KEY)),
    allocation: clone(listRows(ALLOCATION_KEY)),
    borrowplan: clone(plans()),
  }
}

function patchRow(rows: EntryRow[], id: number, patch: Record<string, string | number | boolean>): void {
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index >= 0) rows[index] = { ...rows[index], ...patch }
}

function commitWorkspace(workspace: Workspace): void {
  // 同次落库：五个模块一次写入，任一键写失败 saveModules 会回退内存缓存，整体不生效。
  saveModules({
    [EQUIPMENT_KEY]: workspace.equipment,
    [TEAM_KEY]: workspace.fireteam,
    [DISPATCH_KEY]: workspace.dispatch,
    [ALLOCATION_KEY]: workspace.allocation,
    [PLAN_KEY]: workspace.borrowplan,
  })
}

export function confirmBorrowPlan(planId: number): ActionResult {
  const plan = plans().find((row) => Number(row.id) === planId)
  if (!plan) return { ok: false, message: '编排单不存在' }
  // 幂等：已确认的编排重复提交直接忽略，不再产生新的出动清单与台账。
  if (String(plan.status) === '已确认') {
    return { ok: true, message: `编排单 ${plan['编排编号']} 已确认过，重复提交已忽略` }
  }
  if (!CONFIRMABLE.includes(String(plan.status))) {
    return { ok: false, message: `编排单当前状态「${plan.status}」，不能确认` }
  }
  const lines = parsePlanLines(plan)
  if (lines.length === 0) {
    return { ok: false, message: '领用序列为空，请先生成或调整序列' }
  }
  const team = teamByName(String(plan['扑火队伍']))
  if (!team) {
    return { ok: false, message: `扑火队伍「${plan['扑火队伍']}」不存在，整体未落库` }
  }
  const need = Math.max(0, Math.floor(Number(plan['需求数量']) || 0))
  if (lines.length < need) {
    return { ok: false, message: `可用器材不足：需求 ${need} 台、序列 ${lines.length} 台，整体未落库` }
  }
  // 确认前逐台复核：器材冲突（被占用/送检/报废）直接拦截，整体回退。
  const current = equipmentRows()
  for (const line of lines) {
    const row = current.find((item) => Number(item.id) === line.equipmentId)
    if (!row) {
      return { ok: false, message: `器材冲突：${line.装备编号} 已不在台账，整体未落库` }
    }
    if (String(row.status) !== '可用') {
      return { ok: false, message: `器材冲突：${line.装备编号} 当前状态「${row.status}」，整体未落库` }
    }
  }

  const workspace = loadWorkspace()
  const token = String(plan['提交令牌'] || '') || newToken()
  const teamFarm = String(team['所属林场'] ?? '')
  const planCode = String(plan['编排编号'])

  // 1) 装备状态：序列内装备转已领用。
  for (const line of lines) {
    patchRow(workspace.equipment, line.equipmentId, {
      status: '已领用',
      装备状态: '已领用',
      pending: true,
    })
  }
  // 2) 队伍出动：队伍转已出动（扑救中保持原状）。
  const teamStatus = String(team.status)
  if (teamStatus !== '已出动' && teamStatus !== '扑救中') {
    patchRow(workspace.fireteam, Number(team.id), { status: '已出动', 出动状态: '已出动', pending: true })
  }
  // 3) 队伍出动清单：按关联编排去重，重复提交不重复开单。
  let dispatchCreated = 0
  if (!workspace.dispatch.some((row) => String(row['关联编排']) === planCode)) {
    const nextDispatchCode = codeGenerator(
      workspace.dispatch.map((row) => String(row['清单编号'] ?? '')),
      'DISP',
    )
    workspace.dispatch.push({
      id: nextId(workspace.dispatch),
      status: '已出动',
      pending: true,
      abnormal: false,
      清单编号: nextDispatchCode(),
      出动任务: String(plan['出动任务']),
      扑火队伍: String(plan['扑火队伍']),
      领用装备: lines.map((line) => line.装备编号).join('、'),
      出动时间: nowText(),
      关联编排: planCode,
      清单状态: '已出动',
    })
    dispatchCreated = 1
  }
  // 4) 防火物资调拨台账：跨场装备逐台登记，按调拨单号去重。
  const transferCode = `TRF-${planCode}`
  let allocationCreated = 0
  if (!workspace.allocation.some((row) => String(row['调拨单号']) === transferCode)) {
    const nextAllocationCode = codeGenerator(
      workspace.allocation.map((row) => String(row['台账编号'] ?? '')),
      'ALLO',
    )
    for (const line of lines.filter((item) => item.跨场)) {
      workspace.allocation.push({
        id: nextId(workspace.allocation),
        status: '待调拨',
        pending: true,
        abnormal: false,
        台账编号: nextAllocationCode(),
        调拨单号: transferCode,
        装备编号: line.装备编号,
        装备名称: line.装备名称,
        调出林场: line.保管林场,
        调入林场: teamFarm,
        调拨数量: 1,
        台账状态: '待调拨',
      })
      allocationCreated += 1
    }
  }
  // 5) 编排单本体。
  patchRow(workspace.borrowplan, planId, {
    status: '已确认',
    编排状态: '已确认',
    提交令牌: token,
    pending: true,
    abnormal: false,
  })

  try {
    commitWorkspace(workspace)
  } catch (error) {
    return {
      ok: false,
      message: `落库失败，已整体回退：${error instanceof Error ? error.message : '存储写入异常'}`,
    }
  }
  return {
    ok: true,
    message: `编排 ${planCode} 已确认并同次落库：出动清单 ${dispatchCreated} 张、装备 ${lines.length} 台转已领用、调拨台账 ${allocationCreated} 笔`,
  }
}

// ---------- 核销（联动） ----------

function applyWriteOff(workspace: Workspace, plan: EntryRow): boolean {
  if (String(plan.status) !== '已确认') return false
  const planCode = String(plan['编排编号'])
  const transferCode = `TRF-${planCode}`
  for (const line of parsePlanLines(plan)) {
    const row = workspace.equipment.find((item) => Number(item.id) === line.equipmentId)
    if (row && String(row.status) === '已领用') {
      patchRow(workspace.equipment, line.equipmentId, { status: '可用', 装备状态: '可用', pending: true })
    }
  }
  for (const row of workspace.dispatch.filter((item) => String(item['关联编排']) === planCode)) {
    patchRow(workspace.dispatch, Number(row.id), { status: '已核销', 清单状态: '已核销', pending: false })
  }
  for (const row of workspace.allocation.filter((item) => String(item['调拨单号']) === transferCode)) {
    patchRow(workspace.allocation, Number(row.id), { status: '已归还', 台账状态: '已归还', pending: false })
  }
  patchRow(workspace.borrowplan, Number(plan.id), {
    status: '已核销',
    编排状态: '已核销',
    pending: false,
    abnormal: false,
  })
  return true
}

export function writeOffBorrowPlan(planId: number, reason: string): ActionResult {
  const plan = plans().find((row) => Number(row.id) === planId)
  if (!plan) return { ok: false, message: '编排单不存在' }
  if (String(plan.status) === '已核销') {
    return { ok: true, message: `编排单 ${plan['编排编号']} 已核销过，重复操作已忽略` }
  }
  if (String(plan.status) !== '已确认') {
    return { ok: false, message: `编排单当前状态「${plan.status}」，不能核销` }
  }
  const workspace = loadWorkspace()
  applyWriteOff(workspace, { ...plan })
  try {
    commitWorkspace(workspace)
  } catch (error) {
    return {
      ok: false,
      message: `核销落库失败，已整体回退：${error instanceof Error ? error.message : '存储写入异常'}`,
    }
  }
  return { ok: true, message: `编排单 ${plan['编排编号']} 已核销（${reason}），领用占用已释放` }
}

// 扑火队伍归队提醒/撤回时联动：核销该队伍所有已确认编排的领用占用，同次落库。
export function writeOffByTeam(teamName: string): number {
  const targets = plans().filter(
    (row) => String(row['扑火队伍']) === teamName && String(row.status) === '已确认',
  )
  if (targets.length === 0) return 0
  const workspace = loadWorkspace()
  let count = 0
  for (const plan of targets) {
    if (applyWriteOff(workspace, plan)) count += 1
  }
  commitWorkspace(workspace)
  return count
}

export function cancelBorrowPlan(planId: number): ActionResult {
  const all = plans()
  const plan = all.find((row) => Number(row.id) === planId)
  if (!plan) return { ok: false, message: '编排单不存在' }
  if (String(plan.status) === '已确认') {
    return { ok: false, message: '已确认的编排请先核销占用，再取消' }
  }
  if (String(plan.status) === '已取消') {
    return { ok: true, message: '编排单已取消过，重复操作已忽略' }
  }
  if (String(plan.status) === '已核销') {
    return { ok: false, message: '已核销的编排不能再取消' }
  }
  patchRow(all, planId, { status: '已取消', 编排状态: '已取消', pending: false })
  saveRows(PLAN_KEY, all)
  return { ok: true, message: `编排单 ${plan['编排编号']} 已取消` }
}

// ---------- 附件上传 ----------

export function attachFile(planId: number, file: { name: string; dataUrl: string }): ActionResult {
  const all = plans()
  const index = all.findIndex((row) => Number(row.id) === planId)
  if (index < 0) return { ok: false, message: '编排单不存在' }
  const next = [...all]
  next[index] = { ...all[index], 附件: file.name, 附件数据: file.dataUrl }
  saveRows(PLAN_KEY, next)
  return { ok: true, message: `附件「${file.name}」已上传到编排单 ${all[index]['编排编号']}` }
}

// ---------- 文件导入 ----------

export const IMPORT_TEMPLATE_HEADER = ['出动任务', '扑火队伍', '装备类型', '规格型号', '需求数量']

function parseImportText(text: string): PlanInput[] {
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (trimmed === '') return []
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>[]
    return parsed.map((item) => ({
      出动任务: String(item['出动任务'] ?? ''),
      扑火队伍: String(item['扑火队伍'] ?? ''),
      装备类型: String(item['装备类型'] ?? ''),
      规格型号: String(item['规格型号'] ?? ''),
      需求数量: Number(item['需求数量']) || 0,
    }))
  }
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length === 0) return []
  const header = lines[0].split(',').map((cell) => cell.trim())
  const indexOf = (name: string) => header.indexOf(name)
  return lines.slice(1).map((line) => {
    const cells = line.split(',').map((cell) => cell.trim())
    return {
      出动任务: cells[indexOf('出动任务')] ?? '',
      扑火队伍: cells[indexOf('扑火队伍')] ?? '',
      装备类型: cells[indexOf('装备类型')] ?? '',
      规格型号: cells[indexOf('规格型号')] ?? '',
      需求数量: Number(cells[indexOf('需求数量')]) || 0,
    }
  })
}

export function importPlans(text: string): ActionResult {
  let inputs: PlanInput[]
  try {
    inputs = parseImportText(text)
  } catch {
    return { ok: false, message: '文件解析失败：支持 CSV（含表头）或 JSON 数组' }
  }
  if (inputs.length === 0) {
    return { ok: false, message: '文件里没有可导入的编排行' }
  }
  let created = 0
  let duplicated = 0
  const errors: string[] = []
  inputs.forEach((input, position) => {
    if (findDuplicatePlan(input)) {
      duplicated += 1
      return
    }
    const result = createBorrowPlan(input)
    if (result.ok) {
      created += 1
    } else {
      errors.push(`第${position + 1}行：${result.message}`)
    }
  })
  const parts = [`新增 ${created} 张`, `重复跳过 ${duplicated} 条`, `失败 ${errors.length} 条`]
  const detail = errors.slice(0, 3).join('；')
  return {
    ok: errors.length === 0,
    message: `导入完成：${parts.join('，')}${detail ? `。${detail}` : ''}`,
  }
}

export function downloadImportTemplate(): void {
  const example = ['FIRE-0002 西沟火情', '青松快速扑火队', '风力灭火机', 'EB-650', '2']
  const content = `\uFEFF${IMPORT_TEMPLATE_HEADER.join(',')}\n${example.join(',')}\n`
  downloadBlob('共享借用编排-导入模板.csv', new Blob([content], { type: 'text/csv;charset=utf-8' }))
}

// ---------- 打包下载 ----------

function toCsv(header: string[], rows: (string | number)[][]): string {
  const escape = (value: string | number) => {
    const text = String(value ?? '')
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  return `\uFEFF${[header, ...rows].map((row) => row.map(escape).join(',')).join('\n')}`
}

function planCsvRows(list: EntryRow[]): (string | number)[][] {
  return list.map((row) => [
    String(row['编排编号'] ?? ''),
    String(row['出动任务'] ?? ''),
    String(row['扑火队伍'] ?? ''),
    String(row['装备类型'] ?? ''),
    String(row['规格型号'] ?? ''),
    Number(row['需求数量']) || 0,
    String(row['保管林场'] ?? ''),
    String(row['冲突提示'] ?? ''),
    String(row.status),
  ])
}

function dispatchCsvRows(list: EntryRow[]): (string | number)[][] {
  return list.map((row) => [
    String(row['清单编号'] ?? ''),
    String(row['出动任务'] ?? ''),
    String(row['扑火队伍'] ?? ''),
    String(row['领用装备'] ?? ''),
    String(row['出动时间'] ?? ''),
    String(row['关联编排'] ?? ''),
    String(row.status),
  ])
}

function allocationCsvRows(list: EntryRow[]): (string | number)[][] {
  return list.map((row) => [
    String(row['台账编号'] ?? ''),
    String(row['调拨单号'] ?? ''),
    String(row['装备编号'] ?? ''),
    String(row['装备名称'] ?? ''),
    String(row['调出林场'] ?? ''),
    String(row['调入林场'] ?? ''),
    Number(row['调拨数量']) || 0,
    String(row.status),
  ])
}

const PLAN_HEADER = ['编排编号', '出动任务', '扑火队伍', '装备类型', '规格型号', '需求数量', '保管林场', '冲突提示', '当前状态']
const DISPATCH_HEADER = ['清单编号', '出动任务', '扑火队伍', '领用装备', '出动时间', '关联编排', '当前状态']
const ALLOCATION_HEADER = ['台账编号', '调拨单号', '装备编号', '装备名称', '调出林场', '调入林场', '调拨数量', '当前状态']

// 单张编排打包：编排单 + 领用序列 + 关联出动清单 + 关联调拨台账。
export function downloadPlanBundle(planId: number): ActionResult {
  const plan = plans().find((row) => Number(row.id) === planId)
  if (!plan) return { ok: false, message: '编排单不存在' }
  const planCode = String(plan['编排编号'])
  const lines = parsePlanLines(plan)
  const bundle = zipFiles([
    { name: `编排单-${planCode}.csv`, content: toCsv(PLAN_HEADER, planCsvRows([plan])) },
    {
      name: `领用序列-${planCode}.csv`,
      content: toCsv(
        ['序号', '装备编号', '装备名称', '规格型号', '保管林场', '批次兼容替代', '跨场调拨'],
        lines.map((line, index) => [
          index + 1,
          line.装备编号,
          line.装备名称,
          line.规格型号,
          line.保管林场,
          line.替代 ? '是' : '否',
          line.跨场 ? '是' : '否',
        ]),
      ),
    },
    {
      name: `出动清单-${planCode}.csv`,
      content: toCsv(
        DISPATCH_HEADER,
        dispatchCsvRows(listRows(DISPATCH_KEY).filter((row) => String(row['关联编排']) === planCode)),
      ),
    },
    {
      name: `调拨台账-${planCode}.csv`,
      content: toCsv(
        ALLOCATION_HEADER,
        allocationCsvRows(listRows(ALLOCATION_KEY).filter((row) => String(row['调拨单号']) === `TRF-${planCode}`)),
      ),
    },
  ])
  downloadBlob(`共享借用编排-${planCode}-打包.zip`, bundle)
  return { ok: true, message: `编排单 ${planCode} 已打包下载（4 个 CSV）` }
}

// 全量台账打包：编排单、出动清单、调拨台账、装备状态一览。
export function downloadLedgerBundle(): void {
  const bundle = zipFiles([
    { name: '借用编排单.csv', content: toCsv(PLAN_HEADER, planCsvRows(plans())) },
    { name: '队伍出动清单.csv', content: toCsv(DISPATCH_HEADER, dispatchCsvRows(listRows(DISPATCH_KEY))) },
    { name: '物资调拨台账.csv', content: toCsv(ALLOCATION_HEADER, allocationCsvRows(listRows(ALLOCATION_KEY))) },
    {
      name: '消防装备状态.csv',
      content: toCsv(
        ['装备编号', '装备名称', '装备类型', '规格型号', '保管林场', '购入日期', '最近检修日', '当前状态'],
        equipmentRows().map((row) => [
          String(row['装备编号'] ?? ''),
          String(row['装备名称'] ?? ''),
          String(row['装备类型'] ?? ''),
          String(row['规格型号'] ?? ''),
          String(row['保管林场'] ?? ''),
          String(row['购入日期'] ?? ''),
          String(row['最近检修日'] ?? ''),
          String(row.status),
        ]),
      ),
    },
  ])
  downloadBlob('共享借用编排-台账打包.zip', bundle)
}
