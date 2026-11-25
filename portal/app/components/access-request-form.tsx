"use client";

import { useEffect, useState } from "react";
import { Modal } from "./modal";
import { ModernSelect } from "./modern-select";
import { getEligibleApplications, submitAccessRequest, submitRegisteredAccessRequest, type EligibleApplication } from "../lib/api-client";

const appOption = (app: EligibleApplication) => `${app.registered ? "registered" : "published"}:${app.id}`;

export function AccessRequestFormModal({ application, locale = "zh", onClose, onSubmitted }: {
  application?: EligibleApplication;
  locale?: "zh" | "en";
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [apps, setApps] = useState<EligibleApplication[]>([]);
  const [selected, setSelected] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!application);
  const [submitting, setSubmitting] = useState(false);
  const chinese = locale === "zh";
  const target = application ?? apps.find(app => appOption(app) === selected);
  const appLabel = chinese ? "目标应用" : "Application";
  const reasonLabel = chinese ? "申请原因" : "Reason for access";

  useEffect(() => {
    if (application) return;
    let active = true;
    getEligibleApplications().then(items => {
      if (!active) return;
      setApps(items);
      setSelected(items[0] ? appOption(items[0]) : "");
      setLoading(false);
    }).catch(caught => {
      if (!active) return;
      setError(caught instanceof Error ? caught.message : "可选应用加载失败");
      setLoading(false);
    });
    return () => { active = false; };
  }, [application]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!target || !reason.trim() || submitting) return;
    setError("");
    setSubmitting(true);
    try {
      const requestAccess = target.registered ? submitRegisteredAccessRequest : submitAccessRequest;
      await requestAccess(target.id, reason.trim());
      onSubmitted();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : chinese ? "提交失败" : "Could not submit the request.");
      setSubmitting(false);
    }
  };

  return (
    <Modal title={chinese ? "新建访问申请" : "Request access"} onClose={onClose}>
      <form className="entity-form publication-form access-request-form" aria-label={chinese ? "访问申请表单" : "Access request form"} tabIndex={0} onSubmit={submit}>
        {application && <p>{chinese ? "你无权访问该应用，可以提交申请。" : "You don’t have access to this application. You can request it below."}</p>}
        {loading ? <p role="status">正在加载可申请的应用</p> : (
          <div className="form-grid">
            <label className="form-field form-span">
              <span>{appLabel}</span>
              {application
                ? <input aria-label={appLabel} value={application.name} readOnly />
                : <ModernSelect ariaLabel={appLabel} value={selected} options={apps.map(app => ({ value: appOption(app), label: app.name }))} onChange={setSelected} />}
              {!application && !apps.length && !error && <small>当前没有可申请访问的应用。</small>}
            </label>
            <label className="form-span">
              <span>{reasonLabel} *</span>
              <textarea aria-label={reasonLabel} required maxLength={1000} rows={4} value={reason} onChange={event => setReason(event.target.value)} />
            </label>
          </div>
        )}
        {error && <p className="publication-form-error" role="alert">{error}</p>}
        <footer className="modal-actions">
          <button type="button" onClick={onClose}>{chinese ? "取消" : "Cancel"}</button>
          <button className="primary-action" type="submit" disabled={!target || !reason.trim() || submitting}>
            {submitting ? (chinese ? "提交中" : "Submitting") : (chinese ? "提交访问申请" : "Submit request")}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
