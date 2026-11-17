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
    :failed|:error, :note}`
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

(def ^:private outcomes
  {"fixed" :fixed
   "no-change" :no-change
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

(defn- set-thread-fix
  [thread-id fix]
  (ptk/reify ::set-thread-fix
    ptk/UpdateEvent
    (update [_ state]
      (assoc-in state [:penforge-comment-fixes :threads thread-id] (d/without-nils fix)))))

(defn- fail-running-thread
  "Mark a thread whose run will never report back (lost connection)."
  [thread-id]
  (ptk/reify ::fail-running-thread
    ptk/UpdateEvent
    (update [_ state]
      (if (= :running (:status (get-thread-fix state thread-id)))
        (assoc-in state [:penforge-comment-fixes :threads thread-id] {:status :error})
        state))))

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

(defn- thread-message->events
  [thread-id {:keys [type kind payload ok summary] :as message}]
  (cond
    (and (= type "workflow.event") (= kind "result"))
    (rx/of (set-thread-fix thread-id (report->fix payload)))

    (= type "workflow.done")
    (rx/of (ptk/reify ::thread-run-done
             ptk/UpdateEvent
             (update [_ state]
               (let [fix (get-thread-fix state thread-id)]
                 (if (or (not ok) (= :running (:status fix)))
                   (assoc-in state [:penforge-comment-fixes :threads thread-id]
                             (d/without-nils {:status :error :note (not-empty summary)}))
                   state))))
           (refresh-threads [thread-id]))

    (= type "error")
    (rx/of (set-thread-fix thread-id {:status :error :note (:message message)}))

    :else
    (rx/empty)))

(defn fix-thread
  "Fix one comment thread with AI."
  [{:keys [id page-id]}]
  (let [rid (proto/next-rid)]
    (ptk/reify ::fix-thread
      ptk/UpdateEvent
      (update [_ state]
        (if (and (can-fix? state)
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
                (rx/map (fn [_] (fail-running-thread id))))
           (rx/of (chat/run-workflow "fix-comment"
                                     (cond-> {:thread-id (str id)}
                                       (some? page-id) (assoc :page-id (str page-id)))
                                     {:rid rid :silent true})))
          (rx/empty))))))

;; --- Fix every open thread

(defn- batch-message->events
  [{:keys [type kind payload ok summary] :as message}]
  (cond
    (and (= type "workflow.event") (= kind "progress"))
    (let [thread-id (some-> (:thread-id payload) uuid/parse*)
          step      (:step payload)]
      (rx/concat
       (rx/of (update-batch assoc :progress payload))
       (cond
         (and thread-id (= step "fixing"))
         (rx/of (set-thread-fix thread-id {:status :running}))

         (and thread-id (= step "fixed"))
         (rx/of (set-thread-fix thread-id {:status (get outcomes (:outcome payload) :failed)}))

         :else
         (rx/empty))))

    (and (= type "workflow.event") (= kind "result"))
    (rx/concat
     (rx/of (update-batch assoc :result payload))
     (->> (:fixed payload)
          (keep (fn [report]
                  (when-let [thread-id (some-> (:thread-id report) uuid/parse*)]
                    (set-thread-fix thread-id (report->fix report)))))
          (vec)
          (rx/from)))

    (= type "workflow.done")
    (rx/of (update-batch assoc
                         :status (if ok :done :error)
                         :summary summary)
           (ptk/reify ::batch-done
             ptk/WatchEvent
             (watch [_ state _]
               (let [{:keys [fixed skipped needs-you]} (get-in state [:penforge-comment-fixes :batch :result])]
                 (rx/of (refresh-threads
                         (keep #(some-> (:thread-id %) uuid/parse*)
                               (concat fixed skipped needs-you))))))))

    (= type "error")
    (rx/of (update-batch assoc :status :error :summary (:message message)))

    :else
    (rx/empty)))

(defn fix-comments
  "Fix every open comment of the current page (`:page`) or of the whole
  file (`:file`) with AI. Progress, questions and the summary show in
  the AI tab."
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
          (rx/merge
           (->> (chat/workflow-messages stream rid)
                (rx/mapcat batch-message->events))
           (->> (lost-connection stream rid)
                (rx/map (fn [_] (update-batch assoc :status :error))))
           (rx/of (chat/open-chat)
                  (chat/run-workflow "fix-comments"
                                     (cond-> {:scope (name scope)}
                                       (= scope :page) (assoc :page-id (str (:current-page-id state))))
                                     {:rid rid})))
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
