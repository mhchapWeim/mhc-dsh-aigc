# Application Publishing Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add application publishing requests and reviews, connected by mock workflow state with assignee and candidate-group authorization.

**Architecture:** Extend the shared platform reducer with publication process instances and enforce authorization in pure functions and reducer actions. Add separate request and review pages that consume the same state; navigation visibility and action buttons derive from the current user and active task candidates.

**Tech Stack:** React 19, TypeScript, Vinext/Next App Router, Vitest, Testing Library, Lucide React, existing CSS design system.

**Spec:** User request in the current Codex task.

## Global Constraints

- Do not use real backend APIs; keep state in the existing `PlatformProvider`.
- Do not use `ui-ux-pro-max` or `brainstorming`.
- Preserve the existing Ant Design-inspired admin visual language.
- Authorization must be enforced in state transitions, not only by hiding buttons.
- Approval controls depend on the active node's direct assignees and candidate groups.

---

### Task 1: Workflow authorization and state

**Files:**
- Modify: `app/lib/platform-state.ts`
- Modify: `app/lib/platform-state.test.ts`

**Interfaces:**
- Produces: `PublicationRequest`, `canReviewPublication(user, request)`, submit/review reducer actions.
- Consumes: existing `PlatformUser`, `PlatformState`, and `platformReducer`.

- [ ] Write failing tests for direct-user authorization, candidate-group authorization, unauthorized review rejection, submission, approval, and rejection.
- [ ] Run `vitest app/lib/platform-state.test.ts` and confirm failures are caused by missing publishing behavior.
- [ ] Add initial workflow instances and reducer transitions.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Publishing request and review pages

**Files:**
- Create: `app/admin/publications/page.tsx`
- Create: `app/admin/reviews/page.tsx`
- Modify: `app/admin/admin-pages.test.tsx`

**Interfaces:**
- Request page dispatches `submit-publication` with the current user.
- Review page calls `canReviewPublication` and dispatches `review-publication` with the current actor.

- [ ] Write failing component tests for submitting an application and showing approval actions only on authorized active tasks.
- [ ] Run the focused component tests and confirm expected failures.
- [ ] Build the request list/form and review workbench with accessible labels and status feedback.
- [ ] Run the focused component tests and confirm they pass.

### Task 3: Navigation, portal entry, and styling

**Files:**
- Modify: `app/admin/components/admin-shell.tsx`
- Modify: `app/components/portal-shell.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Portal entry links to `/admin/publications`.
- Admin navigation exposes `发布申请` and conditionally exposes `发布审核` for users with review scope.

- [ ] Add navigation behavior coverage to the existing page tests where observable.
- [ ] Add grouped sidebar entries and pending badge.
- [ ] Add Ant Design-inspired tables, workflow timeline, modal form, responsive rules, and reduced-motion support.
- [ ] Run full tests, ESLint, production build, and browser verification at desktop and 375px.

