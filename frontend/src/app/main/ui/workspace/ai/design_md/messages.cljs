;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.design-md.messages
  "User-facing text of the DESIGN.md panel for the codes the daemon
  sends (progress steps, outcomes, failures, file problems, import
  warnings). Every key is a literal so the translation scanner finds
  it; unknown codes fall back to the daemon's English text."
  (:require
   [app.util.i18n :refer [tr]]))

(defn progress-text
  [{:keys [code summary]}]
  (case code
    "checkpoint"       (tr "penforge.design-md.progress.checkpoint")
    "import-library"   (tr "penforge.design-md.progress.import-library")
    "build-components" (tr "penforge.design-md.progress.build-components")
    "read-file"        (tr "penforge.design-md.progress.read-file")
    "write-notes"      (tr "penforge.design-md.progress.write-notes")
    "draft"            (tr "penforge.design-md.progress.draft")
    (or summary (tr "penforge.design-md.working"))))

(defn notice-text
  [{:keys [workflow outcome]}]
  (case [workflow outcome]
    ["design-md-save" "saved"]                (tr "penforge.design-md.notice.saved")
    ["design-md-save" "unchanged"]            (tr "penforge.design-md.notice.unchanged")
    ["design-md-draft" "drafted"]             (tr "penforge.design-md.notice.drafted")
    ["design-md-draft" "drafted-with-errors"] (tr "penforge.design-md.notice.drafted-with-errors")
    ["design-md-import" "applied"]            (tr "penforge.design-md.notice.applied")
    ["design-md-export" "created"]            (tr "penforge.design-md.notice.created")
    ["design-md-export" "updated"]            (tr "penforge.design-md.notice.updated")
    ["design-md-export" "unchanged"]          (tr "penforge.design-md.notice.export-unchanged")
    (tr "penforge.design-md.notice.done")))

(defn error-text
  [{:keys [code params message]}]
  (case code
    "no-file"          (tr "penforge.design-md.failure.no-file")
    "has-errors"       (tr "penforge.design-md.failure.has-errors" (:count params) (:first params))
    "stopped"          (tr "penforge.design-md.failure.stopped")
    "no-draft"         (tr "penforge.design-md.failure.no-draft")
    "too-large"        (tr "penforge.design-md.failure.too-large")
    "missing-content"  (tr "penforge.design-md.failure.missing-content")
    "missing-prompt"   (tr "penforge.design-md.failure.missing-prompt")
    "penpot-refused"   (tr "penforge.design-md.failure.penpot-refused" (:detail params))
    "penpot-answer"    (tr "penforge.design-md.failure.penpot-answer")
    "connection-lost"  (tr "penforge.design-md.failure.connection-lost")
    "busy"             (tr "penforge.chat.error.busy")
    "not-connected"    (tr "penforge.chat.error.not-connected")
    (tr "penforge.design-md.error" (or message ""))))

(defn issue-text
  [{:keys [code params message]}]
  (let [{:keys [value reference group detail]} params]
    (case code
      "front-matter-missing"  (tr "penforge.design-md.issue.front-matter-missing")
      "front-matter-unclosed" (tr "penforge.design-md.issue.front-matter-unclosed")
      "front-matter-not-map"  (tr "penforge.design-md.issue.front-matter-not-map")
      "yaml-invalid"          (tr "penforge.design-md.issue.yaml-invalid" detail)
      "not-text"              (tr "penforge.design-md.issue.not-text")
      "unknown-key"           (tr "penforge.design-md.issue.unknown-key")
      "omitted-not-list"      (tr "penforge.design-md.issue.omitted-not-list")
      "omitted-entry"         (tr "penforge.design-md.issue.omitted-entry")
      "group-not-map"         (tr "penforge.design-md.issue.group-not-map")
      "entry-not-map"         (tr "penforge.design-md.issue.entry-not-map")
      "property-type"         (tr "penforge.design-md.issue.property-type")
      "no-name"               (tr "penforge.design-md.issue.no-name")
      "not-color"             (tr "penforge.design-md.issue.not-color" value)
      "color-unsupported"     (tr "penforge.design-md.issue.color-unsupported" value)
      "not-dimension"         (tr "penforge.design-md.issue.not-dimension" value)
      "not-padding"           (tr "penforge.design-md.issue.not-padding" value)
      "font-weight"           (tr "penforge.design-md.issue.font-weight")
      "line-height"           (tr "penforge.design-md.issue.line-height")
      "unknown-property"      (tr "penforge.design-md.issue.unknown-property")
      "no-font-family"        (tr "penforge.design-md.issue.no-font-family")
      "no-font-size"          (tr "penforge.design-md.issue.no-font-size")
      "typography-reference"  (tr "penforge.design-md.issue.typography-reference")
      "reference-missing"     (tr "penforge.design-md.issue.reference-missing" reference)
      "reference-cycle"       (tr "penforge.design-md.issue.reference-cycle" reference)
      "reference-group"       (tr "penforge.design-md.issue.reference-group" reference group)
      "duplicate-section"     (tr "penforge.design-md.issue.duplicate-section")
      "section-order"         (tr "penforge.design-md.issue.section-order")
      message)))

(defn warning-text
  [{:keys [code name font weight step detail]}]
  (case code
    "font-missing"        (tr "penforge.design-md.warning.font-missing" name font)
    "weight-missing"      (tr "penforge.design-md.warning.weight-missing" name font weight)
    "tokens-from-library" (tr "penforge.design-md.warning.tokens-from-library")
    "step-failed"         (tr "penforge.design-md.warning.step-failed" step detail)
    (str code)))

(defn activation-text
  [activation]
  (case activation
    "theme" (tr "penforge.design-md.report.activation-theme")
    "set"   (tr "penforge.design-md.report.activation-set")
    ""))
