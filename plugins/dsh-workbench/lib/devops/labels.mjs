/**
 * 平台状态码 → 中文。表来自同机的 `onerway-pmo` 插件（公司自己的读法），
 * 这里只保留工作台用到的三类：需求单、任务、缺陷。
 *
 * 表里没有的码原样显示——平台自己的写法比空白好。
 */

/** 需求单状态。 */
export const DEMAND_STATUS = {
  CREATED: '待处理',
  ACCEPTED: '已受理',
  ANALYZING: '需求分析',
  DESIGNING: '方案设计',
  PENDING_TECH_REVIEW: '待技术评审',
  PENDING_REQUIREMENT_REVIEW: '待需求评审',
  DEVELOPING: '开发中',
  DEV_COMPLETED: '开发完成',
  TESTING: '测试中',
  PENDING_TEST_VERIFY: '待测试验证',
  UAT_TESTING: 'UAT 测试',
  PENDING_ACCEPT: '待验收',
  PENDING_PROD_VERIFY: '待产品验证',
  PENDING_PRODUCT_ACCEPTANCE: '待产品验收',
  PENDING_RELEASE: '待发布',
  PENDING_SCHEDULE: '待排期',
  COMPLETED: '已完成',
}

/** 任务状态。 */
export const TASK_STATUS = {
  CREATED: '待开始',
  IN_PROGRESS: '进行中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
}

/** 缺陷状态。 */
export const DEFECT_STATUS = {
  CREATED: '已提交',
  PENDING_VERIFICATION: '待验证',
  SUSPENDED: '已挂起',
  CLOSED: '已关闭',
  CONFIRMED_REJECTED: '已确认拒绝',
  INVALID_PENDING_CONFIRMATION: '误报待确认',
}

/** 一个状态码读成中文；表里没有就原样返回。 */
export function labelOf(code, table) {
  const value = String(code ?? '').trim()
  if (value === '') return ''
  return table[value] ?? value
}

/**
 * 这个状态算「完结」「取消」还是「还在进行」。
 * 只有完结和取消才可能和你的收尾状态冲突。
 */
export function groupOf(kind, code) {
  const value = String(code ?? '').trim().toUpperCase()
  if (value === '') return 'unknown'
  if (value === 'CANCELLED') return 'cancelled'
  if (kind === 'demand' && value === 'COMPLETED') return 'done'
  if (kind === 'task' && value === 'COMPLETED') return 'done'
  if (kind === 'defect' && value === 'CLOSED') return 'done'
  return 'open'
}
