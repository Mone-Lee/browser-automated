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

/** 勾选表格前 N 个数据行复选框，不操作表头全选框或表格外筛选控件。 */
export function executeTableRowCheckboxAction(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'check-table-rows' }>,
  snapshot: SnapshotEvidence,
): string {
  const outputs: string[] = [];
  agent.waitMs(500);
  let currentSnapshot = captureTransientSnapshot(agent);

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

/** 验证前 N 个数据行均已勾选，并防止额外行被意外选中。 */
export function verifyTableRowCheckboxActionEffect(
  action: Extract<DeterministicAction, { type: 'check-table-rows' }>,
  snapshot: SnapshotEvidence,
): { passed: boolean; message: string } {
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

/** 从无障碍树中提取数据行内部的复选框，并显式排除表头全选框。 */
function findTableRowCheckboxes(snapshotText: string): RowCheckbox[] {
  const checkboxes: RowCheckbox[] = [];
  let rowIndent: number | null = null;
  let rowHasCheckbox = false;

  for (const line of snapshotText.split('\n')) {
    const node = line.match(/^(\s*)-\s+([^\s]+)\b(.*)$/);
    if (!node) {
      continue;
    }

    const indent = node[1]?.length ?? 0;
    const role = node[2]?.toLowerCase() ?? '';
    const metadata = node[3] ?? '';
    if (role === 'row') {
      rowIndent = indent;
      rowHasCheckbox = false;
      continue;
    }
    if (rowIndent !== null && indent <= rowIndent) {
      rowIndent = null;
      rowHasCheckbox = false;
    }
    if (
      rowIndent === null
      || rowHasCheckbox
      || !/^(?:checkbox|menuitemcheckbox)$/.test(role)
      || /"Select all"/i.test(metadata)
    ) {
      continue;
    }

    const ref = metadata.match(/\bref=([^\],\s]+)/)?.[1];
    if (!ref) {
      continue;
    }
    checkboxes.push({ ref, checked: /\bchecked=true\b/.test(metadata) });
    rowHasCheckbox = true;
  }

  return checkboxes;
}
