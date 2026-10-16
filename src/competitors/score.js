const RULE_VERSION = 'rules-v1';
const tokens = value => new Set((value.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length > 1));
function score(target, candidate, keywords) {
  const a = tokens(target.title), b = tokens(candidate.title);
  const shared = [...a].filter(w => b.has(w));
  const similarity = shared.length / Math.max(1, new Set([...a, ...b]).size);
  const matched = keywords.filter(k => candidate.title.toLowerCase().includes(k.toLowerCase()));
  const coverage = matched.length / Math.max(1, keywords.length);
  const sameBrand = !!(target.brand && candidate.brand && target.brand.toLowerCase() === candidate.brand.toLowerCase());
  const comparable = target.currency && target.currency !== 'UNKNOWN_DOLLAR' && target.currency === candidate.currency && target.price > 0 && candidate.price > 0;
  const ratio = comparable ? candidate.price / target.price : null;
  const accessory = /\b(replacement|accessory|accessories|spare|filter|cover|cleaner|cleaning kit)\b/i;
  const accessoryOnly = accessory.test(candidate.title) && !accessory.test(target.title);
  const evidence = [`标题共同词：${shared.join('、') || '无'}`, `完整核心词命中：${matched.join('、') || '无'}`];
  if (sameBrand) evidence.push(`同品牌：${target.brand}`);
  else evidence.push(target.brand && candidate.brand ? `品牌不同：${target.brand} / ${candidate.brand}` : '品牌信息缺失');
  evidence.push(ratio !== null ? `同币种价格比：${ratio.toFixed(2)}` : '价格缺失或币种不确定，不比较价格');
  if (target.category && candidate.category) evidence.push(target.category === candidate.category ? '类目路径相同（仅供参考）' : '类目路径不同');
  const value = Math.round(Math.max(0, Math.min(10, similarity * 5 + coverage * 4 + Math.min(candidate.frequency || 0, 5) * .2)) * 10) / 10;
  let classification = '待人工复核';
  if (sameBrand) classification = '同品牌家族';
  else if (accessoryOnly) classification = '配件耗材（规则提示）';
  else if (coverage >= .5 && similarity >= .2 && (ratio === null || (ratio >= .4 && ratio <= 2.5))) classification = '直接竞品（规则候选）';
  else if (coverage > 0 || similarity >= .15) classification = '同类不同款（规则提示）';
  else if (similarity === 0 && matched.length === 0) classification = '低相关（待复核）';
  if (!candidate.detailLoaded) { classification = '信息不足（待复核）'; evidence.push('详情页未成功采集，品牌与商品关系待确认'); }
  if (accessoryOnly) evidence.push('标题含配件/替换件词，不代表整机竞品');
  return { ...candidate, score: value, classification, explanation: evidence.join('；'), ruleVersion: RULE_VERSION };
}
module.exports = { score, RULE_VERSION };
