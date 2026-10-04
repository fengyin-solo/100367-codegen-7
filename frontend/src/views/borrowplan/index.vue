<template>
  <section class="page" data-module="borrowplan">
    <header class="page-head">
      <div>
        <h2>装备共享借用编排</h2>
        <p class="page-desc">
          值班员按出动任务选择扑火队伍、装备类型与规格型号，形成可调整的领用序列；确认后队伍出动清单、装备状态与防火物资调拨台账同次落库，重复提交只生效一次。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">新建借用编排</button>
        <button class="btn" type="button" @click="triggerImport">导入编排文件</button>
        <input
          ref="importInput"
          type="file"
          accept=".csv,.json"
          class="hidden-input"
          @change="onImportFile"
        />
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section v-if="editor.visible" class="editor-card">
      <h3 class="editor-title">{{ editor.id === null ? '新建借用编排' : `调整借用编排 ${editor.planNo}` }}</h3>
      <div class="editor-grid">
        <label class="editor-item">
          <span>出动任务</span>
          <input v-model="editor.出动任务" list="dispatch-tasks" placeholder="如 FIRE-0002 西山火情增援" />
          <datalist id="dispatch-tasks">
            <option v-for="task in taskOptions" :key="task" :value="task" />
          </datalist>
        </label>
        <label class="editor-item">
          <span>扑火队伍</span>
          <select v-model="editor.扑火队伍">
            <option value="" disabled>请选择扑火队伍</option>
            <option v-for="team in teams" :key="team.队伍名称" :value="team.队伍名称">
              {{ team.队伍名称 }}（{{ team.所属林场 }} · {{ team.状态 }}）
            </option>
          </select>
        </label>
      </div>

      <table class="data-table sequence-table">
        <thead>
          <tr>
            <th>顺序</th>
            <th>装备类型</th>
            <th>规格型号</th>
            <th>数量</th>
            <th>调整</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, index) in editor.items" :key="index">
            <td>{{ index + 1 }}</td>
            <td>
              <select v-model="item.装备类型" @change="onTypeChange(item)">
                <option value="" disabled>选择类型</option>
                <option v-for="type in catalog.types" :key="type" :value="type">{{ type }}</option>
              </select>
            </td>
            <td>
              <select v-model="item.规格型号">
                <option value="" disabled>选择规格</option>
                <option v-for="model in modelsOf(item.装备类型)" :key="model" :value="model">
                  {{ model }}
                </option>
              </select>
            </td>
            <td>
              <input v-model.number="item.数量" type="number" min="1" class="qty-input" />
            </td>
            <td class="row-actions">
              <button class="link" type="button" :disabled="index === 0" @click="moveItem(index, -1)">上移</button>
              <button class="link" type="button" :disabled="index === editor.items.length - 1" @click="moveItem(index, 1)">下移</button>
              <button class="link" type="button" @click="removeItem(index)">删除</button>
            </td>
          </tr>
          <tr v-if="!editor.items.length">
            <td colspan="5" class="empty-state">领用序列为空，请先添加序列项</td>
          </tr>
        </tbody>
      </table>
      <div class="editor-toolbar">
        <button class="btn ghost" type="button" @click="addItem">添加序列项</button>
        <span class="token-label">提交令牌：{{ editor.tokenPreview }}</span>
      </div>

      <div v-if="editor.items.length" class="preview-block">
        <h4>冲突测算（领用序列按顺序占用器材）</h4>
        <ul class="preview-list">
          <li v-for="(line, index) in preview.lines" :key="index">
            <span>{{ line.item.装备类型 }} {{ line.item.规格型号 }} ×{{ line.item.数量 }}：</span>
            <span v-if="line.units.length">
              已匹配 {{ line.units.length }} 台（{{ matchSummary(line) }}）
            </span>
            <span v-if="line.shortage > 0" class="error-text">器材冲突：缺口 {{ line.shortage }} 台</span>
          </li>
        </ul>
        <p v-if="preview.farmConflicts.length" class="warn-text">
          保管林场冲突：{{ preview.farmConflicts.join('；') }}
        </p>
        <p v-else-if="preview.teamFound" class="ok-text">无保管林场冲突</p>
        <p v-if="preview.shortageTotal > 0" class="error-text">
          存在器材缺口，确认落库将被拒绝并整体回退；请调整序列或减少数量。
        </p>
      </div>

      <div class="editor-actions">
        <button class="btn" type="button" @click="saveOnly">保存编排（待确认）</button>
        <button class="btn primary" type="button" @click="saveAndConfirm">保存并确认落库</button>
        <button class="btn ghost" type="button" @click="closeEditor">收起</button>
      </div>
    </section>

    <table class="data-table">
      <thead>
        <tr>
          <th>编排编号</th>
          <th>出动任务</th>
          <th>扑火队伍</th>
          <th>领用序列</th>
          <th>冲突提示</th>
          <th>确认时间</th>
          <th>附件</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in plans" :key="String(row.id)">
          <td>{{ row['编排编号'] }}</td>
          <td>{{ row['出动任务'] }}</td>
          <td>{{ row['扑火队伍'] }}</td>
          <td>{{ formatSequence(row['领用序列']) }}</td>
          <td>
            <span v-if="row['冲突提示']" class="warn-text">{{ row['冲突提示'] }}</span>
            <span v-else>无</span>
          </td>
          <td>
            {{ row['确认时间'] || '—' }}
            <span v-if="needsReturnReminder(row)" class="remind-badge">
              出动超{{ remindHours }}小时，提醒归队核销
            </span>
          </td>
          <td>{{ row['附件名称'] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-if="row.status === '待确认'">
              <button class="link" type="button" @click="editPlan(row)">调整</button>
              <button class="link" type="button" @click="confirmRow(row)">确认落库</button>
              <button class="link" type="button" @click="cancelRow(row)">取消编排</button>
            </template>
            <template v-else-if="row.status === '已确认'">
              <button class="link" type="button" @click="writeoffRow(row)">核销归队</button>
              <button class="link" type="button" @click="packageRow(row)">打包下载</button>
            </template>
            <button class="link" type="button" @click="triggerAttach(row)">上传附件</button>
          </td>
        </tr>
        <tr v-if="!plans.length">
          <td colspan="9" class="empty-state">暂无借用编排，可新建或导入编排文件</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">队伍出动清单（确认时同次落库）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>清单编号</th>
          <th>编排编号</th>
          <th>扑火队伍</th>
          <th>装备编号</th>
          <th>装备名称</th>
          <th>规格型号</th>
          <th>保管林场</th>
          <th>匹配方式</th>
          <th>出动时间</th>
          <th>清单状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in dispatch" :key="String(row.id)">
          <td>{{ row['清单编号'] }}</td>
          <td>{{ row['编排编号'] }}</td>
          <td>{{ row['扑火队伍'] }}</td>
          <td>{{ row['装备编号'] }}</td>
          <td>{{ row['装备名称'] }}</td>
          <td>{{ row['规格型号'] }}</td>
          <td>{{ row['保管林场'] }}</td>
          <td>{{ row['匹配方式'] }}</td>
          <td>{{ row['出动时间'] }}</td>
          <td>{{ row.status }}</td>
        </tr>
        <tr v-if="!dispatch.length">
          <td colspan="10" class="empty-state">暂无出动清单，编排确认后自动生成</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">防火物资调拨台账（确认与核销时同次落库）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>台账编号</th>
          <th>编排编号</th>
          <th>装备编号</th>
          <th>调出林场</th>
          <th>调入队伍</th>
          <th>调拨数量</th>
          <th>调拨类型</th>
          <th>登记时间</th>
          <th>台账状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in ledger" :key="String(row.id)">
          <td>{{ row['台账编号'] }}</td>
          <td>{{ row['编排编号'] }}</td>
          <td>{{ row['装备编号'] }}</td>
          <td>{{ row['调出林场'] }}</td>
          <td>{{ row['调入队伍'] }}</td>
          <td>{{ row['调拨数量'] }}</td>
          <td>{{ row['调拨类型'] }}</td>
          <td>{{ row['登记时间'] }}</td>
          <td>{{ row.status }}</td>
        </tr>
        <tr v-if="!ledger.length">
          <td colspan="9" class="empty-state">暂无调拨台账，编排确认后自动生成</td>
        </tr>
      </tbody>
    </table>

    <input
      ref="attachInput"
      type="file"
      class="hidden-input"
      @change="onAttachFile"
    />

    <footer class="page-foot">
      <span>共 {{ plans.length }} 张借用编排 · 器材冲突按购入批次兼容代用，缺口会拦截确认</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  REMIND_AFTER_HOURS,
  attachToPlan,
  cancelPlan,
  confirmPlan,
  dispatchTaskOptions,
  equipmentCatalog,
  formatSequence,
  importPlans,
  listDispatch,
  listLedger,
  listPlans,
  listTeams,
  needsReturnReminder,
  occupiedCount,
  packagePlan,
  parseSequence,
  previewAllocation,
  saveDraft,
  writeoffPlan,
  type AllocationLine,
  type SequenceItem,
  type TeamOption,
} from '@/api/borrow-service'
import type { EntryRow } from '@/data/types'

const plans = ref<EntryRow[]>([])
const dispatch = ref<EntryRow[]>([])
const ledger = ref<EntryRow[]>([])
const teams = ref<TeamOption[]>([])
const taskOptions = ref<string[]>([])
const catalog = ref<{ types: string[]; modelsByType: Record<string, string[]> }>({
  types: [],
  modelsByType: {},
})
const errorMessage = ref('')
const okMessage = ref('')
const remindHours = REMIND_AFTER_HOURS

const editor = reactive({
  visible: false,
  id: null as number | null,
  planNo: '',
  出动任务: '',
  扑火队伍: '',
  items: [] as SequenceItem[],
  tokenPreview: '',
})

const stats = computed(() => [
  { label: '编排单数', value: plans.value.length },
  { label: '待确认', value: plans.value.filter((row) => String(row.status) === '待确认').length },
  { label: '占用中装备', value: occupiedCount() },
  { label: '归队提醒', value: plans.value.filter((row) => needsReturnReminder(row)).length },
])

const preview = computed(() => previewAllocation(editor.items, editor.扑火队伍))

function modelsOf(type: string): string[] {
  return catalog.value.modelsByType[type] ?? []
}

function matchSummary(line: AllocationLine): string {
  const exact = line.units.filter((unit) => unit.匹配方式 === '精确匹配').length
  const compatible = line.units.length - exact
  const parts = [`精确匹配 ${exact} 台`]
  if (compatible > 0) {
    parts.push(`批次兼容 ${compatible} 台`)
  }
  return parts.join('，')
}

function onTypeChange(item: SequenceItem) {
  const models = modelsOf(item.装备类型)
  item.规格型号 = models[0] ?? ''
}

function addItem() {
  const type = catalog.value.types[0] ?? ''
  editor.items.push({ 装备类型: type, 规格型号: modelsOf(type)[0] ?? '', 数量: 1 })
}

function removeItem(index: number) {
  editor.items.splice(index, 1)
}

function moveItem(index: number, offset: number) {
  const target = index + offset
  if (target < 0 || target >= editor.items.length) {
    return
  }
  const [item] = editor.items.splice(index, 1)
  editor.items.splice(target, 0, item)
}

function freshTokenPreview(): string {
  return `保存时生成 · ${Math.random().toString(36).slice(2, 8).toUpperCase()}`
}

function openCreate() {
  editor.visible = true
  editor.id = null
  editor.planNo = ''
  editor.出动任务 = ''
  editor.扑火队伍 = teams.value[0]?.队伍名称 ?? ''
  editor.items = []
  editor.tokenPreview = freshTokenPreview()
  addItem()
}

function editPlan(row: EntryRow) {
  editor.visible = true
  editor.id = Number(row.id)
  editor.planNo = String(row['编排编号'])
  editor.出动任务 = String(row['出动任务'])
  editor.扑火队伍 = String(row['扑火队伍'])
  editor.items = parseSequence(row['领用序列'])
  editor.tokenPreview = String(row['提交令牌']).slice(0, 13) + '…'
}

function closeEditor() {
  editor.visible = false
}

function showResult(result: { ok: boolean; message: string }) {
  if (result.ok) {
    okMessage.value = result.message
    errorMessage.value = ''
  } else {
    errorMessage.value = result.message
    okMessage.value = ''
  }
}

function saveOnly(): number | null {
  const result = saveDraft({
    id: editor.id ?? undefined,
    出动任务: editor.出动任务,
    扑火队伍: editor.扑火队伍,
    items: editor.items,
  })
  showResult(result)
  if (result.ok && result.planId !== undefined) {
    // 回填 id，避免再次点击保存时重复建单
    editor.id = result.planId
    const saved = listPlans().find((row) => Number(row.id) === result.planId)
    if (saved) {
      editor.planNo = String(saved['编排编号'])
      editor.tokenPreview = String(saved['提交令牌']).slice(0, 13) + '…'
    }
  }
  reload()
  return result.ok && result.planId !== undefined ? result.planId : null
}

function saveAndConfirm() {
  const planId = saveOnly()
  if (planId === null) {
    return
  }
  const saved = listPlans().find((row) => Number(row.id) === planId)
  if (!saved) {
    return
  }
  const result = confirmPlan(planId, String(saved['提交令牌']))
  showResult(result)
  if (result.ok) {
    closeEditor()
  }
  reload()
}

function confirmRow(row: EntryRow) {
  showResult(confirmPlan(Number(row.id), String(row['提交令牌'])))
  reload()
}

function cancelRow(row: EntryRow) {
  showResult(cancelPlan(Number(row.id)))
  reload()
}

function writeoffRow(row: EntryRow) {
  showResult(writeoffPlan(Number(row.id)))
  reload()
}

function packageRow(row: EntryRow) {
  showResult(packagePlan(Number(row.id)))
}

const importInput = ref<HTMLInputElement | null>(null)
const attachInput = ref<HTMLInputElement | null>(null)
const attachPlanId = ref<number | null>(null)

function triggerImport() {
  importInput.value?.click()
}

function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const result = importPlans(file.name, String(reader.result ?? ''))
    showResult(result)
    if (result.errors.length > 0) {
      errorMessage.value = `${result.message}：${result.errors.join('；')}`
      okMessage.value = ''
    }
    reload()
  }
  reader.readAsText(file)
  input.value = ''
}

function triggerAttach(row: EntryRow) {
  attachPlanId.value = Number(row.id)
  attachInput.value?.click()
}

function onAttachFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  const planId = attachPlanId.value
  if (!file || planId === null) {
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    showResult(
      attachToPlan(planId, {
        name: file.name,
        type: file.type,
        size: file.size,
        dataUrl: String(reader.result ?? ''),
      }),
    )
    reload()
  }
  reader.readAsDataURL(file)
  input.value = ''
}

function reload() {
  plans.value = listPlans()
  dispatch.value = listDispatch()
  ledger.value = listLedger()
  teams.value = listTeams()
  taskOptions.value = dispatchTaskOptions()
  catalog.value = equipmentCatalog()
}

onMounted(reload)
</script>

<style scoped>
.editor-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 14px;
}
.editor-title {
  margin: 0 0 10px;
  font-size: 15px;
}
.editor-grid {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.editor-item {
  flex: 1;
  min-width: 240px;
}
.editor-item span {
  display: block;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 4px;
}
.editor-item input,
.editor-item select {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.sequence-table select,
.qty-input {
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.qty-input {
  width: 72px;
}
.editor-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 8px 0;
}
.token-label {
  font-size: 12px;
  color: var(--muted);
}
.preview-block {
  border-top: 1px dashed var(--border);
  padding-top: 8px;
  margin-top: 4px;
}
.preview-block h4 {
  margin: 0 0 6px;
  font-size: 13px;
}
.preview-list {
  margin: 0 0 6px;
  padding-left: 18px;
  font-size: 13px;
}
.editor-actions {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}
.warn-text {
  color: #b45309;
}
.ok-text {
  color: #15803d;
}
.remind-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 8px;
  border-radius: 999px;
  background: #fef3c7;
  color: #b45309;
  font-size: 12px;
}
.section-title {
  margin: 16px 0 8px;
  font-size: 14px;
}
.hidden-input {
  display: none;
}
</style>
