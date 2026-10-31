import sys, tempfile, threading, json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import app
from playwright.sync_api import sync_playwright
from openpyxl import load_workbook
root=Path(__file__).resolve().parents[1];temp=tempfile.TemporaryDirectory();app.DATA=Path(temp.name);app.init();server=app.ThreadingHTTPServer(('127.0.0.1',0),app.Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':1440,'height':1000});errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
  page.goto(f'http://127.0.0.1:{server.server_port}/#token={app.TOKEN}');page.wait_for_function("() => document.getElementById('storage-path').textContent.length>0")
  page.screenshot(path=str(root/'docs/empty-library.png'),full_page=True)
  page.get_by_role('button',name='＋ 保存新模板').click();page.locator('#upload-form input[name=file]').set_input_files(root/'examples/DEMO_template_not_official.xlsx');page.locator('#upload-form input[name=name]').fill('照明类目 · 演示模板');page.locator('input[name=category]').fill('LIGHT_FIXTURE');page.locator('input[name=version]').fill('演示 v1');page.get_by_role('button',name='保存到模板库',exact=True).click();page.locator('.template-card').wait_for()
  # Version management, upload same category v2 and preserve v1.
  page.get_by_role('button',name='＋ 保存新模板').click();page.locator('#upload-form input[name=file]').set_input_files(root/'examples/DEMO_template_not_official.xlsx');page.locator('#upload-form input[name=name]').fill('照明类目 · 演示模板');page.locator('input[name=category]').fill('LIGHT_FIXTURE');page.locator('input[name=version]').fill('演示 v2');page.get_by_role('button',name='保存到模板库',exact=True).click();page.wait_for_function("() => document.querySelectorAll('.template-card').length===2")
  page.locator('.template-card').filter(has_text='演示 v2').get_by_role('button',name='设为默认').click();page.locator('.template-card').filter(has_text='演示 v2').get_by_text('默认版本').wait_for();page.screenshot(path=str(root/'docs/template-library.png'),full_page=True)
  page.locator('.template-card').filter(has_text='演示 v2').get_by_role('button',name='使用此模板 →').click();page.locator('#target-sheet option').first.wait_for(state='attached');page.locator('#source-file').set_input_files(root/'examples/DEMO_products.xlsx');page.locator('#source-sheet option').first.wait_for(state='attached');page.get_by_role('button',name='读取字段，开始匹配 →').click();page.locator('#mapping-table').wait_for();assert page.locator('select[data-target=A]').input_value()=='A';page.locator('input[data-required=A]').check();page.get_by_role('button',name='生成填表草稿',exact=True).click();page.locator('#fill-result').wait_for()
  with page.expect_download() as download:page.get_by_role('button',name='下载Excel草稿').click()
  out=Path(temp.name)/'result.xlsx';download.value.save_as(out);w=load_workbook(out);assert w['Template']['A4'].value=='000123';assert w['Template']['B5'].value=='Reading Lamp';assert w['Data Definitions'].sheet_state=='hidden';assert len(w['Template'].data_validations.dataValidation)==1
  page.screenshot(path=str(root/'docs/fill-workbench.png'),full_page=True)
  page.get_by_role('button',name='▣ 备份与恢复').click()
  with page.expect_download() as download:page.get_by_role('button',name='下载模板库备份').click()
  backup=Path(temp.name)/'backup.zip';download.value.save_as(backup);page.locator('#restore-file').set_input_files(backup);page.get_by_role('button',name='检查并恢复',exact=True).click();page.get_by_text('恢复完成：新增 0 份模板，同内容同版本已跳过',exact=True).wait_for()
  page.get_by_role('button',name='▦ 模板库').click();page.locator('#search').fill('找不到');page.locator('#empty').wait_for();page.locator('#search').fill('');page.wait_for_function("() => document.querySelectorAll('.template-card').length===2")
  page.locator('.template-card').filter(has_text='演示 v1').get_by_role('button',name='归档',exact=True).click();page.wait_for_function("() => document.querySelectorAll('.template-card').length===1");page.locator('#show-archive').check();page.locator('.template-card').filter(has_text='演示 v1').get_by_role('button',name='恢复',exact=True).click();page.locator('.template-card').filter(has_text='演示 v1').get_by_role('button',name='归档',exact=True).wait_for()
  page.set_viewport_size({'width':390,'height':844});page.screenshot(path=str(root/'docs/mobile-library.png'),full_page=True)
  assert not errors,errors;print('Browser PASS: upload, version/default, draft mapping, Excel read-back, backup/restore, search, archive/restore, mobile; no JS errors.')
  browser.close()
finally:server.shutdown();server.server_close();thread.join();temp.cleanup()
