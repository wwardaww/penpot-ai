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
  `design-md-read {ref?}`, `design-md-save {content message? base}`,
  `design-md-draft {prompt content?}`, `design-md-import {content? base}`,
  `design-md-export {prune?}`. Each reports its data in one `result`
  event; steps come as `progress {code}` and stops as `failure {code
  params}`, which the panel translates.

  The editor text is never replaced behind the user's back: a read keeps
  unsaved text, and a draft or export that arrives while the text is
  unsaved becomes a `:proposal` the user accepts or dismisses. Writes
  carry `:base`, the hash of the version on disk the text started from;
  when the file changed meanwhile the daemon answers with a `:conflict`."
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
   :base nil
   :history []
   :issues []
   :viewing nil
   :mode :preview
   :op nil
   :error nil
   :notice nil
   :report nil
   :proposal nil
   :conflict nil
   :not-in-file []
   :confirm-apply false
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
         :notice nil
         :confirm-apply false))

(defn- disk-version
  "Record a version of the file on disk; the editor follows it only
  when it holds no unsaved text."
  [state content hash]
  (cond-> (assoc state :saved content :base hash :exists true)
    (not (dirty? state))
    (assoc :content content)))

(defn- apply-read-result
  [state {:keys [exists content hash ref history issues]}]
  (if (some? ref)
    (assoc state
           :viewing {:ref ref :content content :issues (vec issues)}
           :history (vec history))
    (let [dirty (dirty? state)]
      (cond-> (assoc state
                     :loaded true
                     :exists (boolean exists)
                     :saved content
                     :base hash
                     :history (vec history)
                     :viewing nil)
        (not dirty)
        (assoc :content content :issues (vec issues))))))

(defn- apply-new-file
  "A draft or an export wrote a new file: show it, or offer it when the
  editor has unsaved text."
  [state name {:keys [content hash issues outcome]}]
  (if (dirty? state)
    (-> state
        (disk-version content hash)
        (assoc :proposal {:workflow name :content content :outcome outcome :issues (vec issues)}))
    (-> state
        (disk-version content hash)
        (assoc :issues (vec issues) :proposal nil))))

(defn- apply-result
  [state name {:keys [outcome conflict] :as payload}]
  (let [state (assoc-in state [:op :outcome] outcome)]
    (cond
      (= name read-workflow)
      (apply-read-result state payload)

      (= outcome "conflict")
      (assoc state :conflict conflict)

      (= name save-workflow)
      (assoc state :issues (vec (:issues payload)) :conflict nil)

      (= name import-workflow)
      (assoc state :report payload :conflict nil)

      (= name draft-workflow)
      (apply-new-file state name payload)

      (= name export-workflow)
      (-> (apply-new-file state name payload)
          (assoc :not-in-file (if (:pruned payload) [] (vec (:not-in-file payload)))))

      :else
      state)))

(defn apply-message
  "Apply a daemon message of the run of workflow `name` to the state."
  [state name {:keys [type kind payload ok error message run-id code]}]
  (cond
    (= type "workflow.started")
    (assoc-in state [:op :run-id] run-id)

    (and (= type "workflow.event") (= kind "result"))
    (apply-result state name payload)

    (and (= type "workflow.event") (= kind "progress"))
    (assoc-in state [:op :progress] (select-keys payload [:code :summary]))

    (and (= type "workflow.event") (= kind "question"))
    (assoc-in state [:op :question] payload)

    (and (= type "workflow.event") (= kind "failure"))
    (assoc-in state [:op :failure] payload)

    (= type "workflow.done")
    (let [{:keys [failure outcome]} (:op state)]
      (cond-> (assoc state :op nil)
        (and ok (contains? mutating-workflows name) (not= outcome "conflict"))
        (assoc :notice {:workflow name :outcome outcome})

        (not ok)
        (assoc :error (merge {:message error} failure))))

    (= type "error")
    (assoc state
           :op nil
           :error {:code code :message message})

    :else
    state))

(defn connection-lost
  "The daemon connection dropped: a run in flight will not report back."
  [state]
  (if (busy? state)
    (assoc state :op nil :error {:code "connection-lost"})
    state))

(defn clear-question
  [state]
  (update state :op #(some-> % (dissoc :question))))

(defn accept-proposal
  "Put the proposed file (already saved on disk) in the editor."
  [state]
  (if-let [{:keys [content issues]} (:proposal state)]
    (assoc state :content content :issues issues :proposal nil)
    state))

(defn use-disk-version
  "Resolve a conflict by loading the file found on disk."
  [state]
  (if-let [{:keys [content hash]} (:conflict state)]
    (assoc state :content content :saved content :base hash :exists true :conflict nil)
    state))

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

(def checkpoint-question-options
  "Option ids of the question the import asks when it cannot save a
  version of the file first."
  #{"apply-without-checkpoint" "stop"})

(defn checkpoint-question?
  [question]
  (= checkpoint-question-options (set (map :id (:options question)))))
