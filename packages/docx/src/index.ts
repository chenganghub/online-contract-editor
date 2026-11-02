// canvas-editor docx 插件（npm 1.0.0）的补丁层：导入前扫描、导入后补回、导入报告、导出后修正。
// 插件本身在浏览器（渲染页）里跑；这里都是纯函数，Node 和浏览器都能用。
export { scanDocx, type DocxScan, type ParaInfo, type TableInfo, type SectionInfo, type PageNumberInfo, type DocxFeatures } from './scan'
export { patchImported, type PatchResult, type PatchOptions, type ImportReport, type ReportItem } from './import'
export { fixExportedDocx, exportInfo, prepareForExport, type ExportInfo } from './export'
export { textOf, squeeze, type Doc, type El } from './model'
