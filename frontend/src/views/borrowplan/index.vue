<template>
  <section class="page" data-module="borrowplan">
    <header class="page-head">
      <div>
        <h2>共享借用编排</h2>
        <p class="page-desc">
          值班员按出动任务选择扑火队伍、装备类型与规格型号，形成可调整的领用序列；确认后队伍出动清单、装备状态与防火物资调拨台账同次落库。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="showForm = !showForm">
          {{ showForm ? '收起编排表单' : '新建借用编排' }}
        </button>
        <label class="btn">
          导入编排文件
          <input type="file" accept=".csv,.json" hidden @change="onImportFile" />
        </label>
        <button class="btn" type="button" @click="downloadTemplate">下载导入模板</button>
        <button class="btn" type="button" @click="downloadLedgers">台账打包下载</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form v-if="showForm" class="filter-bar plan-form" @submit.prevent="submitCreate">
      <label class="filter-item">
        <span>出动任务</span>
        <input v-model="form.出动任务" list="borrow-tasks" placeholder="关联火情或填写任务" />
        <datalist id="borrow-tasks">
          <option v-for="task in taskOptions" :key="task" :value="task" />
        </datalist>
      </label>
      <label class="filter-item">
        <span>扑火队伍</span>
        <select v-model="form.扑火队伍">
          <option value="" disabled>选择队伍</option>
          <option v-for="team in teamOptions" :key="team" :value="team">{{ team }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>装备类型</span>
        <select v-model="form.装备类型" @change="form.规格型号 = ''">
          <option value="" disabled>选择类型</option>
          <option v-for="type in typeOptions" :key="type" :value="type">{{ type }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>规格型号</span>
        <select v-model="form.规格型号">
          <option value="" disabled>选择规格</option>
          <option v-for="spec in specOptions" :key="spec" :value="spec">{{ spec }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>需求数量</span>
        <input v-model.number="form.需求数量" type="number" min="1" />
      </label>
      <button class="btn primary" type="submit">生成编排草稿</button>
    </form>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>冲突提示</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="String(row.id)"
          :class="{ 'row-selected': selectedId === Number(row.id) }"
        >
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row['冲突提示'] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="selectPlan(row)">详情</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无借用编排单，可新建或从文件导入</td>
        </tr>
      </tbody>
    </table>

    <section v-if="selected" class="detail-panel">
      <header class="detail-head">
        <strong>领用序列 · {{ selected['编排编号'] }}</strong>
        <span class="detail-meta">
          {{ selected['扑火队伍'] }} · {{ selected['装备类型'] }} {{ selected['规格型号'] }} ×
          {{ selected['需求数量'] }} · 状态「{{ selected.status }}」
          <template v-if="selected['提交令牌']"> · 令牌 {{ selected['提交令牌'] }}</template>
        </span>
      </header>

      <table class="data-table">
        <thead>
          <tr>
            <th>序号</th>
            <th>装备编号</th>
            <th>装备名称</th>
            <th>规格型号</th>
            <th>保管林场</th>
            <th>标记</th>
            <th v-if="editable">调整</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(line, index) in selectedLines" :key="line.equipmentId">
            <td>{{ index + 1 }}</td>
            <td>{{ line.装备编号 }}</td>
            <td>{{ line.装备名称 }}</td>
            <td>{{ line.规格型号 }}</td>
            <td>{{ line.保管林场 }}</td>
            <td>
              <span v-if="line.替代" class="tag tag-sub">批次兼容替代</span>
              <span v-if="line.跨场" class="tag tag-cross">跨场调拨</span>
              <span v-if="!line.替代 && !line.跨场">—</span>
            </td>
            <td v-if="editable" class="row-actions">
              <button class="link" type="button" :disabled="index === 0" @click="moveLine(index, -1)">上移</button>
              <button
                class="link"
                type="button"
                :disabled="index === selectedLines.length - 1"
                @click="moveLine(index, 1)"
              >
                下移
              </button>
              <button class="link" type="button" @click="removeLine(index)">移除</button>
            </td>
          </tr>
          <tr v-if="!selectedLines.length">
            <td :colspan="editable ? 7 : 6" class="empty-state">序列为空，点击下方「重新检测冲突」生成</td>
          </tr>
        </tbody>
      </table>

      <div class="conflict-panel">
        <p v-if="conflicts.crossFarm.length" class="conflict-line">
          保管林场冲突：{{ conflicts.crossFarm.join('；') }}
        </p>
        <p v-if="conflicts.substituted.length" class="conflict-line">
          批次兼容替代：{{ conflicts.substituted.join('；') }}
        </p>
        <p v-if="conflicts.occupied.length" class="conflict-line">
          器材占用冲突：{{ conflicts.occupied.join('、') }} 不可领用
        </p>
        <p v-if="conflicts.shortage > 0" class="conflict-line conflict-danger">
          器材缺口 {{ conflicts.shortage }} 台，确认时将被拦截
        </p>
        <p v-if="!hasConflict" class="conflict-ok">无冲突，可确认编排</p>
      </div>

      <div class="detail-actions">
        <template v-if="editable">
          <button class="btn" type="button" @click="rebuild">重新检测冲突</button>
          <button class="btn primary" type="button" @click="runAction('确认编排', selected)">确认编排并落库</button>
        </template>
        <button
          v-if="String(selected.status) === '已确认'"
          class="btn"
          type="button"
          @click="runAction('核销占用', selected)"
        >
          核销占用
        </button>
        <label class="btn">
          上传附件
          <input type="file" hidden @change="onUploadFile" />
        </label>
        <a v-if="attachmentUrl" class="link" :href="attachmentUrl" :download="String(selected['附件'])">
          下载附件：{{ selected['附件'] }}
        </a>
        <span v-else-if="selected['附件']" class="detail-meta">附件：{{ selected['附件'] }}（仅登记）</span>
        <button class="btn" type="button" @click="downloadBundle">打包下载此单</button>
      </div>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 张借用编排单</span>
      <span v-if="message" class="ok-text">{{ message }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  attachFile,
  createBorrowPlan,
  describePlan,
  dispatchTasks,
  downloadImportTemplate,
  downloadLedgerBundle,
  downloadPlanBundle,
  equipmentTypes,
  importPlans,
  parsePlanLines,
  plans as loadPlans,
  rebuildSequence,
  specsOfType,
  teams,
  updatePlanLines,
  type BorrowLine,
  type ConflictReport,
} from '@/api/borrow-service'
import { filterRows, moduleMeta, runAction as applyAction } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('borrowplan')
const columns = ['编排编号', '出动任务', '扑火队伍', '装备类型', '规格型号', '需求数量', '保管林场']
const actions = ['确认编排', '核销占用', '取消编排']
const statuses = ['草稿', '待确认', '已确认', '已核销', '已取消']
const filterFields = ['编排编号', '出动任务', '扑火队伍']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const showForm = ref(false)
const selectedId = ref<number | null>(null)

const form = ref({ 出动任务: '', 扑火队伍: '', 装备类型: '', 规格型号: '', 需求数量: 1 })

const teamOptions = computed(() => teams().map((row) => String(row['队伍名称'] ?? '')))
const typeOptions = computed(() => equipmentTypes())
const specOptions = computed(() => (form.value.装备类型 ? specsOfType(form.value.装备类型) : []))
const taskOptions = computed(() => dispatchTasks())

const stats = computed(() => [
  { label: '编排单数', value: rows.value.length },
  { label: '已确认待核销', value: rows.value.filter((row) => String(row.status) === '已确认').length },
  { label: '已核销', value: rows.value.filter((row) => String(row.status) === '已核销').length },
  {
    label: '冲突编排',
    value: rows.value.filter((row) => String(row['冲突提示'] ?? '') !== '' && String(row['冲突提示']) !== '无冲突').length,
  },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const selected = computed(() => rows.value.find((row) => Number(row.id) === selectedId.value) ?? null)
const selectedLines = computed<BorrowLine[]>(() => (selected.value ? parsePlanLines(selected.value) : []))
const editable = computed(
  () => selected.value !== null && ['草稿', '待确认'].includes(String(selected.value.status)),
)
const emptyReport: ConflictReport = { crossFarm: [], substituted: [], occupied: [], shortage: 0 }
const conflicts = computed<ConflictReport>(() =>
  selected.value ? describePlan(selected.value) : emptyReport,
)
const hasConflict = computed(
  () =>
    conflicts.value.crossFarm.length > 0 ||
    conflicts.value.substituted.length > 0 ||
    conflicts.value.occupied.length > 0 ||
    conflicts.value.shortage > 0,
)
const attachmentUrl = computed(() => {
  const data = String(selected.value?.['附件数据'] ?? '')
  return data.startsWith('data:') ? data : ''
})

function reload() {
  errorMessage.value = ''
  try {
    const matched = filterRows(loadPlans(), filters.value)
    rows.value = matched
    total.value = matched.length
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '借用编排列表读取失败'
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function notify(result: { ok: boolean; message: string }) {
  if (result.ok) {
    message.value = result.message
    errorMessage.value = ''
  } else {
    errorMessage.value = result.message
    message.value = ''
  }
  reload()
}

function submitCreate() {
  const result = createBorrowPlan({ ...form.value })
  if (result.ok && typeof result.id === 'number') {
    selectedId.value = result.id
    showForm.value = false
    form.value = { 出动任务: '', 扑火队伍: '', 装备类型: '', 规格型号: '', 需求数量: 1 }
  }
  notify(result)
}

function selectPlan(row: EntryRow) {
  selectedId.value = Number(row.id)
  // 草稿还没有序列时自动生成一版，值班员直接看到冲突情况。
  if (['草稿', '待确认'].includes(String(row.status)) && parsePlanLines(row).length === 0) {
    rebuildSequence(Number(row.id))
    reload()
  }
}

function runAction(action: string, row: EntryRow) {
  message.value = ''
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  notify(result)
}

function persistLines(lines: BorrowLine[]) {
  if (!selected.value) return
  notify(updatePlanLines(Number(selected.value.id), lines))
}

function moveLine(index: number, offset: number) {
  const lines = [...selectedLines.value]
  const target = index + offset
  if (target < 0 || target >= lines.length) return
  const [item] = lines.splice(index, 1)
  lines.splice(target, 0, item)
  persistLines(lines)
}

function removeLine(index: number) {
  const lines = [...selectedLines.value]
  lines.splice(index, 1)
  persistLines(lines)
}

function rebuild() {
  if (!selected.value) return
  notify(rebuildSequence(Number(selected.value.id)))
}

function downloadBundle() {
  if (!selected.value) return
  notify(downloadPlanBundle(Number(selected.value.id)))
}

function downloadTemplate() {
  downloadImportTemplate()
}

function downloadLedgers() {
  downloadLedgerBundle()
  message.value = '台账打包已下载（编排单、出动清单、调拨台账、装备状态）'
}

function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => notify(importPlans(String(reader.result ?? '')))
  reader.onerror = () => {
    errorMessage.value = '文件读取失败'
  }
  reader.readAsText(file, 'utf-8')
}

function onUploadFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !selected.value) return
  const planId = Number(selected.value.id)
  // 大文件只登记文件名，避免撑爆 localStorage。
  if (file.size > 300 * 1024) {
    notify(attachFile(planId, { name: `${file.name}（${Math.ceil(file.size / 1024)}KB，仅登记）`, dataUrl: '' }))
    return
  }
  const reader = new FileReader()
  reader.onload = () => notify(attachFile(planId, { name: file.name, dataUrl: String(reader.result ?? '') }))
  reader.onerror = () => {
    errorMessage.value = '附件读取失败'
  }
  reader.readAsDataURL(file)
}

onMounted(reload)
</script>

<style scoped>
.plan-form {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.detail-panel {
  margin-top: 14px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.detail-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 10px;
}
.detail-meta {
  color: var(--muted);
  font-size: 12px;
}
.row-selected td {
  background: #eef4ff;
}
.tag {
  display: inline-block;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 12px;
  margin-right: 4px;
}
.tag-sub {
  background: #e0f2fe;
  color: #075985;
}
.tag-cross {
  background: #fee2e2;
  color: #b42318;
}
.conflict-panel {
  margin: 10px 0;
  font-size: 13px;
}
.conflict-line {
  margin: 4px 0;
  color: #92400e;
}
.conflict-danger {
  color: #b42318;
  font-weight: 600;
}
.conflict-ok {
  margin: 4px 0;
  color: #15803d;
}
.detail-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.ok-text {
  color: #15803d;
}
</style>
