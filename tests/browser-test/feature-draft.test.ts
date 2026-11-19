/** 验证起草校验：缺少规则版本、数据审查或前提混写时必须拒绝，合格草案正常通过。 */
import { describe, expect, it } from 'vitest';
import { RULES_VERSION, draftFromAgentSteps, renderDraftPreview, reviewFeatureDraft } from '../../packages/browser-test/dist/index.js';

const node = (title: string) => ({ title, path: [title], children: {}, raw: {} });
const imported = {
  file: 'cases.json',
  warnings: [],
  cases: [{
    title: '佣金查看', structure: 'sections' as const, modulePath: ['商品'],
    node: node('佣金查看 已登录中台 进入商品库 查看佣金 展示佣金'),
    preconditions: [node('已登录中台'), node('进入商品库')], steps: [node('查看佣金')], expectedResults: [node('展示佣金')],
  }],
};
const steps = [
  { keyword: 'Given', text: '已登录中台' },
  { keyword: 'And', text: '进入商品库' },
  { keyword: 'When', text: '查看佣金' },
  { keyword: 'Then', text: '展示佣金' },
];
const dataReview = { required: false, basis: '原文未依赖特定数据', missing: [] as string[] };
const make = (over: Record<string, unknown> = {}, rulesVersion = RULES_VERSION) =>
  draftFromAgentSteps(imported, { rulesVersion, cases: [{ modulePath: ['商品'], title: '佣金查看', steps, dataReview, ...over }] } as never);

describe('起草校验', () => {
  it('合格草案通过，且不再追加通用兜底待确认', async () => {
    const draft = await make();
    expect(draft.scenarios[0].steps.some(step => step.todo)).toBe(false);
  });

  it('拒绝缺失或过期的 rulesVersion', async () => {
    await expect(make({}, '')).rejects.toThrow('rulesVersion');
    await expect(make({}, 'stale')).rejects.toThrow('rulesVersion');
  });

  it('拒绝缺少 dataReview', async () => {
    await expect(make({ dataReview: undefined })).rejects.toThrow('dataReview');
  });

  it('拒绝前提混写登录与导航，以及笼统的待确认问题', async () => {
    await expect(make({ steps: [{ keyword: 'Given', text: '已登录中台，进入商品库' }, ...steps.slice(2)] })).rejects.toThrow('混合了登录');
    await expect(make({ steps: [{ ...steps[0], todo: '证据不足' }, ...steps.slice(1)] })).rejects.toThrow('笼统');
  });

  it('missing 中的具体问题落为待确认项', async () => {
    const draft = await make({ dataReview: { required: true, basis: '依赖业务库数据', missing: ['请提供业务库名称与成功添加的 SKU 编码'] } });
    expect(draft.scenarios[0].steps[0].todo).toContain('业务库名称');
  });

  it('不同执行身份的场景拆成独立 feature，且都来自同一份草案', async () => {
    const two = { ...imported, cases: [imported.cases[0], { ...imported.cases[0], title: '佣金无权限' }] };
    const draft = await draftFromAgentSteps(two, { rulesVersion: RULES_VERSION, cases: [
      { modulePath: ['商品'], title: '佣金查看', steps, dataReview, role: '价格调整权限' },
      { modulePath: ['商品'], title: '佣金无权限', steps, dataReview, role: '无权限' },
    ] } as never);
    const review = await reviewFeatureDraft(draft, '/tmp/browser-test-role-unused');
    expect(review.files.map(file => file.path.split('/').pop())).toEqual(['商品__role-价格调整权限__cases.feature', '商品__role-无权限__cases.feature']);
    expect(review.files[1].content).toContain('# 执行身份: 无权限');
    expect(renderDraftPreview(draft)).toContain('Feature: 商品（身份：价格调整权限）');
  });
});
