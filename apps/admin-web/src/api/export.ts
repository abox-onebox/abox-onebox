import { http } from './request';

/**
 * 后台导出任务（2026-11-21）
 *
 * 提交只拿 taskId，生成在队列里做；本文件不拼 CSV —— 产物由服务端写 StorageProvider，
 * 端上只负责展示任务状态与打开下载链接。列定义因此只有服务端一份。
 */
export type ExportTaskStatus = 'pending' | 'running' | 'done' | 'failed';

export interface ExportTaskRow {
  id: number;
  taskNo: string;
  kind: string;
  label: string;
  filterJson: string | null;
  status: ExportTaskStatus;
  rowCount: number;
  fileKey: string | null;
  fileName: string | null;
  error: string | null;
  createdBy: number | null;
  createdName: string | null;
  createdAt: string | null;
  finishedAt: string | null;
}

export function fetchExportTasks(): Promise<ExportTaskRow[]> {
  return http.get<ExportTaskRow[]>('/admin/export-tasks');
}

export function createExportTask(payload: {
  kind: string;
  filter?: Record<string, unknown>;
}): Promise<ExportTaskRow> {
  return http.post<ExportTaskRow>('/admin/export-tasks', payload);
}

export function retryExportTask(id: number): Promise<ExportTaskRow> {
  return http.post<ExportTaskRow>(`/admin/export-tasks/${id}/retry`);
}

export function fetchExportDownload(id: number): Promise<{ url: string; fileName: string }> {
  return http.get<{ url: string; fileName: string }>(`/admin/export-tasks/${id}/download`);
}
