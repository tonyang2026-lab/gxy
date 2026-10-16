const ExcelJS = require('exceljs');
async function workbook(job, file) {
  const book = new ExcelJS.Workbook();
  const overview = book.addWorksheet('概览');
  overview.addRows([
    ['项目', '内容'], ['目标ASIN', job.options.asin], ['站点', job.options.marketplace], ['状态', job.status], ['采集时间', job.updatedAt], ['评分方式', job.ruleVersion], ['核心词', job.options.keywords.join(' / ')], ['候选数量', job.results.length], ['详情成功数量', job.results.filter(r => r.detailLoaded).length], ['采集说明', job.message], ['错误与未覆盖项', job.errors.join('\n')], ['范围', `每词${job.options.pages}页；详情上限${job.options.limit}；不代表全站竞品`], ['评分说明', '规则启发式0～10分，无概率；标题相似度50%+核心词覆盖40%+来源频次10%；分类须人工复核'], ['价格说明', '保留页面币种；$符号无法判明币种时不参与价格比较；不做分/元猜测']
  ]);
  overview.columns = [{ width: 24 }, { width: 100 }];
  const columns = [ ['asin','ASIN',16], ['title','标题',70], ['score','规则分数',12], ['classification','规则分类',28], ['brand','品牌',22], ['price','价格',14], ['currency','币种',18], ['priceText','原价格文本',20], ['frequency','来源命中数',15], ['bestPosition','最好搜索位次',25], ['keywords','命中搜索词',50], ['explanation','证据备注',110], ['detailLoaded','详情成功',14], ['evidence','采集来源',110] ];
  for (const [name, rows] of [['全量候选', job.results], ['直接竞品', job.results.filter(r => r.classification === '直接竞品（规则候选）')]]) {
    const sheet = book.addWorksheet(name);
    sheet.columns = columns.map(([key, header, width]) => ({ key, header, width }));
    rows.forEach(r => sheet.addRow({ ...r, keywords: r.keywords.join(' / '), evidence: JSON.stringify(r.evidence), detailLoaded: r.detailLoaded ? '是' : '否' }));
    sheet.views = [{ state: 'frozen', ySplit: 1 }]; sheet.autoFilter = { from: 'A1', to: 'N1' };
  }
  await book.xlsx.writeFile(file);
}
module.exports = { workbook };
