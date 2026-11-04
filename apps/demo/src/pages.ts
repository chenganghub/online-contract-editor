import './pages.css'

/** Pages 只展示前端能力，文档留在访问者浏览器。samples：可选的合同范本，换范本时改地址上的 ?sample= 重新打开 */
export function showPagesNotice(storageKey: string, samples: { id: string; title: string }[], current: string) {
  const notice = document.createElement('aside')
  notice.className = 'pages-notice'
  notice.setAttribute('aria-label', '在线演示说明')
  const text = document.createElement('span')
  text.textContent = '在线演示 · 可编辑模板、填写和盖章，打开和下载 Word、PDF 等文件，保存仅在当前浏览器。带文字层的 PDF 和模板发布请本地运行完整服务。'
  const picker = document.createElement('label')
  picker.textContent = '范本'
  const select = document.createElement('select')
  select.setAttribute('aria-label', '合同范本')
  for (const s of samples) select.add(new Option(s.title, s.id, false, s.id === current))
  select.onchange = () => {
    const url = new URL(location.href)
    url.searchParams.set('sample', select.value)
    location.href = url.href
  }
  picker.append(select)
  const source = document.createElement('a')
  source.href = 'https://github.com/chenganghub/online-contract-editor'
  source.textContent = 'GitHub 源码'
  const reset = document.createElement('button')
  reset.type = 'button'
  reset.textContent = '重置样例'
  reset.onclick = () => {
    if (!window.confirm('清除本浏览器保存的这份演示文档，恢复初始样例？')) return
    localStorage.removeItem(storageKey)
    location.reload()
  }
  notice.append(text, picker, source, reset)
  document.body.classList.add('pages-demo')
  document.body.prepend(notice)
}
