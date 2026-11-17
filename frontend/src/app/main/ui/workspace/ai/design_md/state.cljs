;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.design-md.state
  "Local state of the DESIGN.md panel (W22) and how the daemon messages
  of its workflow runs change it. Pure functions; the panel keeps the
  state in a component atom.

  Workflows (daemon, `agent/workflows/design-md-*.ts`):
  `design-md-read {ref?}`, `design-md-save {content message?}`,
  `design-md-draft {prompt}`, `design-md-import {content?}`,
  `design-md-export {}`. Each reports its data in one `result` event."
  (:require
   [cuerdas.core :as str]))

(def read-workflow "design-md-read")
(def save-workflow "design-md-save")
(def draft-workflow "design-md-draft")
(def import-workflow "design-md-import")
(def export-workflow "design-md-export")

(def mutating-workflows
  "Workflows after which the panel reads the file and its history again."
  #{save-workflow draft-workflow import-workflow export-workflow})

(def initial-state
  {:loaded false
   :exists false
   :content ""
   :saved ""
   :history []
   :issues []
   :viewing nil
   :mode :preview
   :op nil
   :error nil
   :notice nil
   :report nil
   :prompt ""})

(defn busy?
  [state]
  (some? (:op state)))

(defn dirty?
  "True when the editor holds text that is not saved."
  [state]
  (not= (:content state) (:saved state)))

(defn error-count
  [issues]
  (count (filter #(= "error" (:severity %)) issues)))

(defn start-op
  "Mark a workflow run as started for request `rid`."
  [state name rid]
  (assoc state
         :op {:name name :rid rid}
         :error nil
         :notice nil))

(defn- apply-read-result
  [state {:keys [exists content ref history issues]}]
  (if (some? ref)
    (assoc state
           :viewing {:ref ref :content content :issues (vec issues)}
           :history (vec history))
    (assoc state
           :loaded true
           :exists (boolean exists)
           :content content
           :saved content
           :history (vec history)
           :issues (vec issues)
           :viewing nil)))

(defn- apply-result
  [state name payload]
  (cond
    (= name read-workflow)
    (apply-read-result state payload)

    (= name save-workflow)
    (assoc state :issues (vec (:issues payload)))

    (= name import-workflow)
    (assoc state :report payload)

    ;; draft and export return the new file; the read that follows
    ;; refreshes the history
    (contains? #{draft-workflow export-workflow} name)
    (assoc state
           :content (:content payload)
           :saved (:content payload)
           :exists true
           :issues (vec (:issues payload)))

    :else
    state))

(defn apply-message
  "Apply a daemon message of the run of workflow `name` to the state."
  [state name {:keys [type kind payload ok summary error message run-id]}]
  (cond
    (= type "workflow.started")
    (assoc-in state [:op :run-id] run-id)

    (and (= type "workflow.event") (= kind "result"))
    (apply-result state name payload)

    (and (= type "workflow.event") (= kind "progress"))
    (cond-> state
      (string? (:summary payload))
      (assoc-in [:op :progress] (:summary payload)))

    (and (= type "workflow.event") (= kind "question"))
    (assoc-in state [:op :question] payload)

    (= type "workflow.done")
    (cond-> (assoc state :op nil)
      ok
      (assoc :notice (when (contains? mutating-workflows name) summary))

      (not ok)
      (assoc :error (or (not-empty error) summary)))

    (= type "error")
    (assoc state
           :op nil
           :error (or (not-empty message) "error"))

    :else
    state))

(defn clear-question
  [state]
  (update state :op #(some-> % (dissoc :question))))

(defn split-front-matter
  "Split DESIGN.md text into its YAML front matter (without the fences)
  and the Markdown body. Text without front matter is all body."
  [text]
  (let [text (str/replace (or text "") #"\r\n?" "\n")]
    (if-let [[_ yaml body] (re-find #"^---\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$" text)]
      {:front-matter yaml :body (str/trim (or body ""))}
      {:front-matter nil :body text})))

(defn short-commit
  [commit]
  (subs (str commit) 0 (min 7 (count (str commit)))))

(defn report-counts
  "Number of added and updated elements of one kind of an import report."
  [counts]
  [(count (:created counts)) (count (:updated counts))])
