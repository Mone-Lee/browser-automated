/**
 * 表格行复选框动作文件，负责按当前表格顺序批量勾选前 N 条数据，
 * 并通过 snapshot 中的行级选择状态确认集合动作完整生效。
 */
import type { BrowserAgent } from '#browser-core/agent';
import type { DeterministicAction, SnapshotEvidence } from '../../../type.js';
import { captureTransientSnapshot } from '../../evidence.js';

interface RowCheckbox {
  ref: string;
  checked: boolean;
}

interface TableCheckboxes {
  selectAll: RowCheckbox | null;
  rows: RowCheckbox[];
}

/** 按需勾选表头全选框，或逐行勾选表格前 N 个数据行复选框。 */
export function executeTableRowCheckboxAction(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'check-table-rows' }>,
  snapshot: SnapshotEvidence,
): string {
  const outputs: string[] = [];
  agent.waitMs(500);
  let currentSnapshot = captureTransientSnapshot(agent);

  if (action.target === 'select-all') {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const checkbox = findTableCheckboxes(currentSnapshot.text).selectAll;
      if (!checkbox) {
        if (attempt === 3) {
          throw new Error('未找到表格顶部的全选复选框。');
        }
        outputs.push(`selection retry ${attempt}: 表格仍在刷新，等待后重新获取全选复选框`);
        agent.waitMs(500);
        currentSnapshot = captureTransientSnapshot(agent);
        continue;
      }

      if (!checkbox.checked) {
        agent.scrollIntoView(checkbox.ref);
        outputs.push(`check @${checkbox.ref}\n${agent.check(checkbox.ref)}`);
      } else {
        outputs.push(`checkbox skipped @${checkbox.ref}: already checked`);
      }

      agent.waitMs(300);
      currentSnapshot = captureTransientSnapshot(agent);
      if (verifyTableRowCheckboxActionEffect(action, currentSnapshot).passed) {
        outputs.push(`selection confirmed after attempt ${attempt}`);
        return outputs.join('\n');
      }
      outputs.push(`selection retry ${attempt}: 全选状态未生效，基于最新表格重试`);
    }

    return outputs.join('\n');
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const checkboxes = findTableRowCheckboxes(currentSnapshot.text);
    if (checkboxes.length < action.count) {
      if (attempt === 3) {
        throw new Error(`表格行复选框不足：需要 ${action.count} 个，当前找到 ${checkboxes.length} 个。`);
      }
      outputs.push(`selection retry ${attempt}: 表格仍在刷新，等待后重新获取行复选框`);
      agent.waitMs(500);
      currentSnapshot = captureTransientSnapshot(agent);
      continue;
    }

    for (const checkbox of checkboxes.slice(0, action.count)) {
      if (checkbox.checked) {
        outputs.push(`checkbox skipped @${checkbox.ref}: already checked`);
        continue;
      }
      agent.scrollIntoView(checkbox.ref);
      outputs.push(`check @${checkbox.ref}\n${agent.check(checkbox.ref)}`);
    }

    agent.waitMs(300);
    currentSnapshot = captureTransientSnapshot(agent);
    if (verifyTableRowCheckboxActionEffect(action, currentSnapshot).passed) {
      outputs.push(`selection confirmed after attempt ${attempt}`);
      return outputs.join('\n');
    }
    outputs.push(`selection retry ${attempt}: 选中状态未达到目标，基于最新表格补选`);
  }

  return outputs.join('\n');
}

/** 验证表头全选框，或前 N 个数据行的最终勾选状态。 */
export function verifyTableRowCheckboxActionEffect(
  action: Extract<DeterministicAction, { type: 'check-table-rows' }>,
  snapshot: SnapshotEvidence,
): { passed: boolean; message: string } {
  if (action.target === 'select-all') {
    const checkbox = findTableCheckboxes(snapshot.text).selectAll;
    return checkbox?.checked
      ? { passed: true, message: '已确认表格顶部的全选复选框处于选中状态。' }
      : { passed: false, message: '表格顶部的全选复选框未处于选中状态。' };
  }

  const checkboxes = findTableRowCheckboxes(snapshot.text);
  const selectedCount = checkboxes.filter((checkbox) => checkbox.checked).length;
  const firstRowsSelected = checkboxes.length >= action.count
    && checkboxes.slice(0, action.count).every((checkbox) => checkbox.checked);

  if (firstRowsSelected && selectedCount === action.count) {
    return { passed: true, message: `已确认表格前 ${action.count} 条数据行处于选中状态。` };
  }

  return {
    passed: false,
    message: `表格行勾选未达到目标：要求前 ${action.count} 条且仅选中 ${action.count} 条，当前共选中 ${selectedCount} 条。`,
  };
}

/** 从无障碍树中区分表头全选框与数据行复选框，兼容无文本的表头复选框。 */
function findTableCheckboxes(snapshotText: string): TableCheckboxes {
  const result: TableCheckboxes = { selectAll: null, rows: [] };
  let currentRow: { indent: number; checkbox: RowCheckbox | null; isHeader: boolean } | null = null;

  const flushRow = () => {
    if (!currentRow?.checkbox) {
      return;
    }
    if (currentRow.isHeader) {
      result.selectAll ??= currentRow.checkbox;
    } else {
      result.rows.push(currentRow.checkbox);
    }
  };

  for (const line of snapshotText.split('\n')) {
    const node = line.match(/^(\s*)-\s+([^\s]+)\b(.*)$/);
    if (!node) {
      continue;
    }

    const indent = node[1]?.length ?? 0;
    const role = node[2]?.toLowerCase() ?? '';
    const metadata = node[3] ?? '';
    if (currentRow && indent <= currentRow.indent) {
      flushRow();
      currentRow = null;
    }
    if (role === 'row') {
      currentRow = { indent, checkbox: null, isHeader: false };
      continue;
    }
    if (currentRow && role === 'columnheader') {
      currentRow.isHeader = true;
      continue;
    }
    if (!/^(?:checkbox|menuitemcheckbox)$/.test(role)) {
      continue;
    }

    const ref = metadata.match(/\bref=([^\],\s]+)/)?.[1];
    if (!ref) {
      continue;
    }
    const checkbox = { ref, checked: /\bchecked=true\b/.test(metadata) };
    if (/"(?:Select all|全选)"/i.test(metadata)) {
      result.selectAll ??= checkbox;
      if (currentRow) {
        currentRow.isHeader = true;
      }
      continue;
    }
    if (currentRow && !currentRow.checkbox) {
      currentRow.checkbox = checkbox;
    }
  }

  flushRow();
  return result;
}

/** 提取数据行内部的首个复选框，并排除表头全选框。 */
function findTableRowCheckboxes(snapshotText: string): RowCheckbox[] {
  return findTableCheckboxes(snapshotText).rows;
}
