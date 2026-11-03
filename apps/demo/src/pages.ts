import './pages.css'

/** Pages 只展示前端能力，文档留在访问者浏览器。 */
export function showPagesNotice(storageKey: string) {
  const notice = document.createElement('aside')
  notice.className = 'pages-notice'
  notice.setAttribute('aria-label', '在线演示说明')
  const text = document.createElement('span')
  text.textContent = '在线演示 · 可编辑模板、填写和盖章，保存仅在当前浏览器。Word 导入、服务端导出及模板发布请本地运行。'
  const source = document.createElement('a')
  source.href = 'https://github.com/chenganghub/online-contract-editor'
  source.textContent = 'GitHub 源码'
  const reset = document.createElement('button')
  reset.type = 'button'
  reset.textContent = '重置样例'
  reset.onclick = () => {
    if (!window.confirm('清除本浏览器保存的演示文档，恢复初始样例？')) return
    localStorage.removeItem(storageKey)
    location.reload()
  }
  notice.append(text, source, reset)
  document.body.classList.add('pages-demo')
  document.body.prepend(notice)
}
