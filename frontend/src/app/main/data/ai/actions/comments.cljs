;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.comments
  "Fix canvas comments with AI (W07).

  `fix-thread` runs the daemon workflow `fix-comment` for one thread
  (the \"Fix with AI\" button of the thread popover); `fix-comments`
  runs `fix-comments` for every open thread of the page or file (the
  \"Fix comments\" header action).

  State lives under `:penforge-comment-fixes`:
  - `:threads` thread id (uuid) -> `{:status :running|:fixed|:no-change|
    :unchanged|:failed|:error, :note, :rid|:batch}` (`:rid` of a single
    run, `:batch` rid of the batch that touched it)
  - `:batch` `{:status :running|:done|:error, :rid, :progress, :result,
    :summary}`"
  (:require
   [app.common.data :as d]
   [app.common.uuid :as uuid]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.client :as client]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.comments :as dcm]
   [app.main.data.helpers :as dsh]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(def ^:private finished-types
  #{"workflow.done" "error"})

;; Daemon outcome -> thread fix status; `resolved` = resolved by someone
;; else while the batch ran.
(def ^:private outcomes
  {"fixed" :fixed
   "no-change" :no-change
   "unchanged" :unchanged
   "resolved" :no-change
   "failed" :failed})

;; --- State helpers

(defn connected?
  [state]
  (= :connected (get-in state [:penforge :connection :status])))

(defn can-edit?
  "Whether the profile may change the open file."
  [state]
  (boolean
   (and (get-in (dsh/lookup-team state) [:permissions :can-edit])
        (not (get-in state [:workspace-global :read-only?])))))

(defn can-fix?
  "Whether the AI may fix comments for the profile right now."
  [state]
  (and (client/enabled?)
       (connected? state)
       (can-edit? state)))

(defn get-thread-fix
  [state thread-id]
  (get-in state [:penforge-comment-fixes :threads thread-id]))

(defn batch-running?
  [state]
  (= :running (get-in state [:penforge-comment-fixes :batch :status])))

(defn editor-ids
  "Ids of the team members who can edit the open file."
  [state]
  (let [team (dsh/lookup-team state)]
    (into #{}
          (comp (filter #(or (:is-owner %) (:is-admin %) (:can-edit %)))
                (map :id))
          (:members team))))

(defn trusted-thread-ids
  "Ids (strings) of the open threads of `page-id` (every page when nil)
  whose owner and participants can all edit the file. Only these reach
  Claude in a batch: comment text from viewers or guests could carry
  instructions. The Penforge bot counts as an editor: the backend lets
  only editors post as the bot."
  [state page-id]
  (let [editors (conj (editor-ids state) dcm/penforge-bot-id)]
    (->> (vals (:comment-threads state))
         (filter #(or (nil? page-id) (= page-id (:page-id %))))
         (remove :is-resolved)
         (filter (fn [{:keys [owner-id participants]}]
                   (every? #(contains? editors %) (cons owner-id participants))))
         (mapv #(str (:id %))))))

(defn- set-thread-fix
  [thread-id fix]
  (ptk/reify ::set-thread-fix
    ptk/UpdateEvent
    (update [_ state]
      (assoc-in state [:penforge-comment-fixes :threads thread-id] (d/without-nils fix)))))

(defn- update-batch
  [f & args]
  (ptk/reify ::update-batch
    ptk/UpdateEvent
    (update [_ state]
      (apply update-in state [:penforge-comment-fixes :batch] f args))))

(defn- refresh-threads
  "Fetch threads (and their comments) again: the daemon changed them
  through the plugin and comments are not pushed to clients."
  [thread-ids]
  (ptk/reify ::refresh-threads
    ptk/WatchEvent
    (watch [_ state _]
      (->> (distinct thread-ids)
           (keep #(get-in state [:comment-threads %]))
           (mapcat (fn [thread]
                     [(dcm/refresh-comment-thread thread)
                      (dcm/retrieve-comments (:id thread))]))
           (vec)
           (rx/from)))))

(defn- lost-connection
  "Stream that emits once when the daemon socket closes before the run
  finishes."
  [stream rid]
  (->> stream
       (rx/filter (ptk/type? ::client/socket-closed))
       (rx/take 1)
       (rx/take-until (->> (chat/workflow-messages stream rid)
                           (rx/filter #(contains? finished-types (:type %)))))))

;; --- Fix one thread

(defn- report->fix
  [{:keys [outcome note]}]
  {:status (get outcomes outcome :failed)
   :note (not-empty note)})

(defn- finish-thread
  "End the run of one thread (done, error or lost connection): a thread
  still running gets `:error`, then the thread is fetched again."
  [thread-id note]
  (ptk/reify ::finish-thread
    ptk/UpdateEvent
    (update [_ state]
      (if (= :running (:status (get-thread-fix state thread-id)))
        (assoc-in state [:penforge-comment-fixes :threads thread-id]
                  (d/without-nils {:status :error :note (not-empty note)}))
        state))

    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (refresh-threads [thread-id])))))

(defn- thread-message->events
  [thread-id {:keys [type kind payload ok summary] :as message}]
  (cond
    (and (= type "workflow.event") (= kind "result"))
    (rx/of (set-thread-fix thread-id (report->fix payload)))

    (= type "workflow.done")
    (rx/of (finish-thread thread-id (when-not ok summary)))

    (= type "error")
    (rx/of (finish-thread thread-id (:message message)))

    :else
    (rx/empty)))

(defn fix-thread
  "Fix one comment thread with AI. Refused while a batch runs."
  [{:keys [id page-id]}]
  (let [rid (proto/next-rid)]
    (ptk/reify ::fix-thread
      ptk/UpdateEvent
      (update [_ state]
        (if (and (can-fix? state)
                 (not (batch-running? state))
                 (not= :running (:status (get-thread-fix state id))))
          (assoc-in state [:penforge-comment-fixes :threads id] {:status :running :rid rid})
          state))

      ptk/WatchEvent
      (watch [_ state stream]
        (if (= rid (:rid (get-thread-fix state id)))
          (rx/merge
           (->> (chat/workflow-messages stream rid)
                (rx/mapcat (partial thread-message->events id)))
           (->> (lost-connection stream rid)
                (rx/map (fn [_] (finish-thread id nil))))
           (rx/of (chat/run-workflow "fix-comment"
                                     (cond-> {:thread-id (str id)}
                                       (some? page-id) (assoc :page-id (str page-id)))
                                     {:rid rid :silent true})))
          (rx/empty))))))

;; --- Fix every open thread

(defn- finish-batch
  "End a batch (done, error, cancel or lost connection): threads it left
  running get `:error`, then the thread list and the comments of every
  thread it touched are fetched again."
  [rid status summary]
  (ptk/reify ::finish-batch
    ptk/UpdateEvent
    (update [_ state]
      (if (= rid (get-in state [:penforge-comment-fixes :batch :rid]))
        (-> state
            (update-in [:penforge-comment-fixes :batch] assoc :status status :summary summary)
            (update-in [:penforge-comment-fixes :threads]
                       (fn [threads]
                         (reduce-kv (fn [threads id fix]
                                      (if (and (= rid (:batch fix)) (= :running (:status fix)))
                                        (assoc threads id {:status :error :batch rid})
                                        threads))
                                    threads
                                    threads))))
        state))

    ptk/WatchEvent
    (watch [_ state _]
      (let [{:keys [fixed skipped needs-you]} (get-in state [:penforge-comment-fixes :batch :result])
            touched (concat (keep (fn [[id fix]] (when (= rid (:batch fix)) id))
                                  (get-in state [:penforge-comment-fixes :threads]))
                            (keep #(some-> (:thread-id %) uuid/parse*)
                                  (concat fixed skipped needs-you)))
            file-id (:current-file-id state)]
        (rx/concat
         (if file-id
           (rx/of (dcm/retrieve-comment-threads file-id))
           (rx/empty))
         (->> (distinct touched)
              (map dcm/retrieve-comments)
              (vec)
              (rx/from)))))))

(defn- batch-message->events
  [rid {:keys [type kind payload ok summary] :as message}]
  (cond
    (and (= type "workflow.event") (= kind "progress"))
    (let [thread-id (some-> (:thread-id payload) uuid/parse*)
          step      (:step payload)]
      (rx/concat
       (rx/of (update-batch assoc :progress payload))
       (cond
         (and thread-id (= step "fixing"))
         (rx/of (set-thread-fix thread-id {:status :running :batch rid}))

         (and thread-id (= step "fixed"))
         (rx/of (set-thread-fix thread-id {:status (get outcomes (:outcome payload) :failed)
                                           :batch rid}))

         :else
         (rx/empty))))

    (and (= type "workflow.event") (= kind "result"))
    (rx/concat
     (rx/of (update-batch assoc :result payload))
     (->> (:fixed payload)
          (keep (fn [report]
                  (when-let [thread-id (some-> (:thread-id report) uuid/parse*)]
                    (set-thread-fix thread-id (assoc (report->fix report) :batch rid)))))
          (vec)
          (rx/from)))

    (= type "workflow.done")
    (rx/of (finish-batch rid (if ok :done :error) summary))

    (= type "error")
    (rx/of (finish-batch rid :error (:message message)))

    :else
    (rx/empty)))

(defn fix-comments
  "Fix every open comment of the current page (`:page`) or of the whole
  file (`:file`) with AI. Progress, questions and the summary show in
  the AI tab. Only threads written by editors are sent for fixing."
  [scope]
  (let [rid (proto/next-rid)]
    (ptk/reify ::fix-comments
      ptk/UpdateEvent
      (update [_ state]
        (if (and (can-fix? state) (not (batch-running? state)))
          (assoc-in state [:penforge-comment-fixes :batch] {:status :running :rid rid :scope scope})
          state))

      ptk/WatchEvent
      (watch [_ state stream]
        (if (= rid (get-in state [:penforge-comment-fixes :batch :rid]))
          (let [page-id (when (= scope :page) (:current-page-id state))]
            (rx/merge
             (->> (chat/workflow-messages stream rid)
                  (rx/mapcat (partial batch-message->events rid)))
             (->> (lost-connection stream rid)
                  (rx/map (fn [_] (finish-batch rid :error nil))))
             (rx/of (chat/open-chat)
                    (chat/run-workflow "fix-comments"
                                       (cond-> {:scope (name scope)
                                                :trusted-thread-ids (trusted-thread-ids state page-id)}
                                         (some? page-id) (assoc :page-id (str page-id)))
                                       {:rid rid}))))
          (rx/empty))))))

;; --- Actions

(actions/register-action!
 {:id :ai/fix-comments
  :label #(tr "penforge.actions.fix-comments")
  :icon i/comments
  :order 20
  :scopes #{:header :main-menu :command-palette}
  :visible? can-edit?
  :enabled? #(and (can-fix? %) (not (batch-running? %)))
  :run (fn [_] (st/emit! (fix-comments :page)))})

(actions/register-action!
 {:id :ai/fix-file-comments
  :label #(tr "penforge.actions.fix-file-comments")
  :icon i/comments
  :order 21
  :scopes #{:main-menu :command-palette}
  :visible? can-edit?
  :enabled? #(and (can-fix? %) (not (batch-running? %)))
  :run (fn [_] (st/emit! (fix-comments :file)))})
