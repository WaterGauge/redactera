import { CREDENTIAL_STORAGE_MESSAGES } from '../types/settings';
import { BACKEND_STARTUP_MESSAGES } from './backendStartupFailure';

type ErrorContext = 'open' | 'process' | 'export' | 'settings-read' | 'settings-save' | 'log-folder';
const FALLBACK: Record<ErrorContext, string> = {
  open: '无法打开文件，请重新选择 PDF 文件。',
  process: '处理未完成，请重试；若仍失败，请更换文件或识别方式。',
  export: '无法导出文件，请检查保存位置的权限和可用空间后重试。',
  'settings-read': '无法读取设置，请重新打开设置后重试。',
  'settings-save': '设置保存失败，请重试。',
  'log-folder': '无法选择日志文件夹，请换一个位置后重试。',
};
const KNOWN = [
  ...Object.values(BACKEND_STARTUP_MESSAGES),
  ...Object.values(CREDENTIAL_STORAGE_MESSAGES).filter(Boolean),
  '设置保存失败，原设置已保留。请检查目录权限和磁盘空间后重试。',
  '设置已变更或凭证未成功载入，请重新读取设置后再保存。',
  '凭证加密失败，设置未保存。请解锁系统安全存储后重试。',
  '识别设置已变更，请确认设置后再处理。',
  '设置已变更，请重新读取后再保存。',
  '请一次选择一个 PDF 文件。',
  '没有生成处理结果，请重试', '没有生成导出文件，请重试',
];

/** Translate known failures; never echo arbitrary paths, provider bodies or credentials. */
export function userError(error: unknown, context: ErrorContext): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const message = raw.replace(/^Error invoking remote method ['"][^'"]+['"]: (?:Error: )?/, '').replace(/^Error: /, '');
  if (KNOWN.includes(message)) return message;
  if (message === '系统安全存储不可用') return CREDENTIAL_STORAGE_MESSAGES.unavailable;
  if (/无法读取遮盖位置/.test(message)) return '无法读取遮盖位置，请重新处理后再检查结果。';
  if (/Cannot confirm backend termination/.test(message)) return '尚未确认处理已停止，请重启应用后再试。';
  if (/Backend (?:build identity|contract)|incompatible backend|backend.*(?:identity|startup).*timeout/i.test(message)) return '处理组件无法启动，请重新安装应用后再试。';
  if (/Python (?:process|backend).*(?:stopped|not running|unavailable)/i.test(message)) return '处理服务无法使用，请重启应用后再试。';
  if (message === 'PDF import exceeds file size limit') return '拖入文件超过 512 MB，请通过文件选择窗口打开。';
  if (message === 'Virtual PDF import exceeds size limit') return '这份文件无法直接拖入，请先保存到本机后重试。';
  if (message === 'PDF import exceeds session storage limit') return '本次已导入较多文件，请重新打开应用后继续。';
  if (message === 'PDF imports already in progress') return '上一项文件仍在导入，请稍候再试。';
  if (/busy|already in progress/i.test(message)) return '上一项任务尚未结束，请稍候再试。';
  if (/timed? ?out|deadline exceeded/i.test(message)) return '处理时间过长，请减少文件页数或更换识别方式后重试。';
  if (/Request cancelled/i.test(message)) return '处理已取消，可以重新处理。';
  if (/ENOSPC|No space left on device/i.test(message)) return '磁盘空间不足，请腾出空间后重试。';
  if (/EACCES|EPERM|Permission(?:Error| denied)/i.test(message)) {
    if (context === 'settings-save') return '设置保存失败，请检查应用配置文件夹的权限后重试。';
    if (context === 'settings-read') return '无法读取设置，请检查应用配置文件夹的权限后重试。';
    if (context === 'log-folder') return '无法访问这个文件夹，请换一个位置后重试。';
    return context === 'export' ? '无法保存文件，请检查保存位置的权限，或换一个文件夹后重试。'
      : '无法读取文件，请检查文件权限，或将文件移到可访问的文件夹后重新选择。';
  }
  if (/ENOENT|FileNotFoundError|No such file/i.test(message)) return '找不到文件，请重新选择文件或保存位置。';
  if (/Please (?:save|choose a log folder) outside application temporary storage/.test(message)) return '请选择应用临时文件夹以外的位置。';
  if (/Access denied|not allowlisted|Invalid generated|Invalid PDF response/i.test(message)) return '文件或处理结果已失效，请重新选择文件后处理。';
  if (/cannot open (?:broken|empty)|Failed to open file|FileDataError|no objects found|password|encrypted document/i.test(message)) return '无法打开这份 PDF，请确认文件未损坏、未加密后重新选择。';
  if (/XFA/.test(message)) return '暂不支持动态表单，请先将文件另存为普通 PDF 后重试。';
  if (/带数字签名/.test(message)) return '暂不处理带数字签名的 PDF，请先生成不带签名的副本。';
  if (/无法安全清理嵌入字体/.test(message)) return '无法处理这份 PDF 的字体，请先另存为标准 PDF 后重试。';
  if (/图像无法安全地局部打码/.test(message)) return '无法安全处理这份 PDF 中的图片，本次未生成结果。请先转换为普通 PDF 后重试。';
  if (/tesseract.*(?:not installed|not in your PATH)|Error opening data file|Failed loading language/i.test(message)) return '本地文字识别组件无法使用，请重新安装应用，或在设置中选择其他识别方式。';
  if (/Paddle|Baidu|百度|HTTPS|paddle_api_url/.test(message)) {
    if (/401|403|Token Invalid|invalid.*(?:token|key)|token.*(?:invalid|required)|凭证|requires both/i.test(message)) return '文字识别服务拒绝了请求，请检查服务凭证和可用额度后重试。';
    if (/HTTPS|URL|paddle_api_url/.test(message)) return '文字识别服务地址不可用，请在设置中填写有效的 HTTPS 地址。';
    return '文字识别服务未能完成请求，请检查网络和服务配置后重试。';
  }
  return FALLBACK[context];
}
