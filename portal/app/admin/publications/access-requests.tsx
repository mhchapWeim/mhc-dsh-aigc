"use client";

import { useEffect, useState } from "react";
import { Modal } from "../../components/modal";
import {
  getAccessRequest,
  type AccessRequestItem,
} from "../../lib/api-client";

export const accessStatusText: Record<string, string> = {
  Reviewing: "审核中", Approved: "已通过", Rejected: "已驳回", Failed: "未授权",
};

export function AccessRequestDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [detail, setDetail] = useState<AccessRequestItem | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => {
      getAccessRequest(id).then(setDetail).catch(caught => setError(caught instanceof Error ? caught.message : "详情加载失败"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [id]);
  return (
    <Modal title="访问申请详情" onClose={onClose}>
      <div className="request-detail" tabIndex={0} aria-label="访问申请详情正文">
        {error && <p className="model-form-error" role="alert">{error}</p>}
        {detail ? (
          <>
            <dl className="request-metadata">
              <div><dt>申请人</dt><dd>{detail.applicantName || "当前用户"}</dd></div>
              <div><dt>目标应用</dt><dd>{detail.appName}</dd></div>
              <div><dt>状态</dt><dd>{accessStatusText[detail.status] ?? detail.status}</dd></div>
              <div className="is-span"><dt>申请原因</dt><dd>{detail.reason}</dd></div>
            </dl>
            <h3>流转记录</h3>
            <ol className="request-history">{(detail.history ?? []).map(item => <li key={`${item.createdAt}-${item.eventType}`}>{item.eventType} · {item.nodeKey} · {item.detail}</li>)}</ol>
          </>
        ) : !error && <p role="status">正在加载详情</p>}
      </div>
    </Modal>
  );
}
