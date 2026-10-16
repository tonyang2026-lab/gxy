(function (root) {
  const templates = [
    { id: 'daily', name: '每日运营巡检', note: '先看异常，再处理当天订单、广告和库存；根据你使用的 FBA / 自配送模式删减。', tasks: [
      '检查账号健康、绩效通知和待处理事项', '检查订单异常、取消订单与自配送待发货订单', '处理买家消息，核对后台显示的回复要求', '检查商品在售状态、购物车归属和价格异常', '检查广告花费、预算消耗与异常活动', '检查可售库存、缺货风险和在途货件', '记录今日销售、花费、异常及跟进事项'
    ] },
    { id: 'listing', name: '商品上架与优化', note: '上架前先确认目标站点、类目、销售资质及适用要求。', tasks: [
      '确认目标站点、类目、销售资质与商品合规要求', '整理商品规格、品牌信息、成本和利润测算', '核对商品编码、SKU 与变体关系', '整理关键词并检查标题、五点及详情页内容', '核对主图、附图及素材使用权', '设置价格、配送方式并检查库存数量', '预览商品页面，检查报错与内容展示', '记录上架信息并安排上线后的数据复查'
    ] },
    { id: 'ads', name: '广告复盘', note: '先明确目标和数据观察周期；结合转化归因延迟分析，不按固定阈值自动调价。', tasks: [
      '确认本次广告目标、预算与复盘周期', '核对广告销售与自然销售的数据口径', '查看曝光、点击、CTR、CPC、订单和转化率', '查看 ACOS 与 ROAS，并结合毛利评估效果', '分析搜索词与投放目标，标记相关和不相关流量', '拟定否定词、出价和预算调整清单', '检查广告商品的价格、库存及页面转化问题', '记录调整内容，并安排后续效果复查'
    ] },
    { id: 'inventory', name: '库存与补货', note: '结合销量、采购和运输周期、季节性及后台容量信息估算；不使用统一补货天数。', tasks: [
      '汇总可售、预留、在途和不可售库存', '检查销量趋势、活动计划与季节性变化', '核对供应商交期、运输时间和预计入仓时间', '估算补货数量并检查采购预算', '核对 FBA 容量、库龄和相关费用信息', '按后台流程核对货件、标签及包装要求', '跟踪运输与接收差异，记录待跟进问题'
    ] },
    { id: 'support', name: '售后与买家服务', note: '按对应站点和订单的官方流程处理，保护买家信息。', tasks: [
      '整理待处理买家消息和售后工单', '核对订单状态、配送责任与问题证据', '按适用政策处理退货、退款或换货', '检查索赔、拒付及后台要求的处理期限', '归类差评和退货原因，记录商品改进点', '核对跟进结果，关闭已解决的工单'
    ] },
    { id: 'weekly', name: '每周经营复盘', note: '汇总上架、广告、库存和售后问题，形成下一轮任务。', tasks: [
      '汇总本周销售、退款、广告及主要费用', '核对利润与回款，记录数据差异', '复盘重点商品的流量和转化变化', '复盘广告调整效果与下一步计划', '确认下周补货、促销和上新安排', '汇总售后和账号风险的未结事项', '列出下周优先任务并分配负责人'
    ] }
  ];
  function append(plan, id, makeId) {
    const template = templates.find(t => t.id === id);
    if (!template) return { plan, added: 0, duplicates: 0, overflow: 0 };
    const tasks = [...plan.tasks]; let added = 0, duplicates = 0, overflow = 0;
    for (const title of template.tasks) {
      if (tasks.some(t => !t.done && t.title === title)) { duplicates++; continue; }
      if (tasks.length >= 100) { overflow++; continue; }
      tasks.push({ id: makeId(), title, done: false, rewarded: false, food: null }); added++;
    }
    return { plan: { tasks }, added, duplicates, overflow };
  }
  const api = { templates, append };
  if (typeof module !== 'undefined') module.exports = api;
  else root.AmazonTemplates = api;
})(globalThis);
