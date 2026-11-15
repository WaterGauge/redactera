import React, { useState } from 'react';
import type { AppSettings } from '../types/settings';
import { ModalDialog } from './ModalDialog';

export type ExportDpi = AppSettings['export_dpi'];
export type ExportOptions = { format: 'pdf' } | { format: 'png_zip'; dpi: ExportDpi };

export function ExportDialog({ fileName, defaultDpi, onClose, onConfirm }: {
  fileName: string;
  defaultDpi: ExportDpi;
  onClose: () => void;
  onConfirm: (options: ExportOptions) => void;
}) {
  const [dpi, setDpi] = useState<ExportDpi>(defaultDpi);
  return <ModalDialog className="export-dialog" labelledBy="export-title" describedBy="export-description" onDismiss={onClose}>
    <div className="drawer-header"><h2 id="export-title" className="drawer-title">导出为图片</h2>
      <button type="button" className="drawer-close" aria-label="关闭导出窗口" onClick={onClose}>×</button></div>
    <div className="export-dialog-body">
      <p id="export-description">每页一张 PNG，保存为 ZIP 文件。</p><p className="export-file-name">{fileName}</p>
      <fieldset className="export-format" aria-describedby="image-export-dpi-help"><legend>图片清晰度</legend>
        <div className="image-dpi-options">
          {([150, 200, 300] as const).map(value => <label key={value} className={`radio-option${dpi === value ? ' selected' : ''}`}>
            <input type="radio" name="image-export-dpi" value={value} checked={dpi === value} onChange={() => setDpi(value)} /><span>{value} DPI</span>
          </label>)}
        </div>
        <p id="image-export-dpi-help" className="form-help-text">数值越高，图片尺寸和文件体积越大。仅用于本次导出。</p>
      </fieldset>
    </div>
    <div className="drawer-footer"><button type="button" className="btn-drawer-cancel" onClick={onClose}>取消</button>
      <button type="button" data-testid="export-png-button" className="btn-drawer-save" onClick={() => onConfirm({ format: 'png_zip', dpi })}>选择保存位置</button></div>
  </ModalDialog>;
}
