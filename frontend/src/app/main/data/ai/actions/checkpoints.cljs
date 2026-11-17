;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.checkpoints
  "AI checkpoints (W19): the AI history list, \"Undo last AI change\"
  and going back to a checkpoint. The daemon does the work through the
  `checkpoint-*` workflows (architecture §7).

  State lives under `[:penforge :checkpoints]`:

  - `:status` `:idle` `:loading` `:loaded` `:error`
  - `:items` checkpoints, newest first (daemon `Checkpoint` maps, kebab
    keys: `:id :n :label :workflow :at :file-version :design-sha
    :app-sha :tag :restored-at :warnings`)
  - `:undo-target-id` checkpoint \"Undo last AI change\" goes back to
  - `:busy` `nil`, `:create` or the id of the checkpoint being restored
  - `:diffs` code diffs by checkpoint id, `{:status :data}`"
  (:require
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.client :as client]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.modal :as modal]
   [app.main.data.notifications :as ntf]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(def state-path [:penforge :checkpoints])

(def empty-state
  {:status :idle
   :items []
   :undo-target-id nil
   :busy nil
   :diffs {}})

(def modal-type :penforge-checkpoints)

;; --- Pure helpers

(defn apply-listing
  "Store a `checkpoint-list` result."
  [state {:keys [checkpoints undo-target-id]}]
  (assoc state
         :status :loaded
         :items (vec checkpoints)
         :undo-target-id undo-target-id))

(defn find-checkpoint
  [checkpoints id]
  (some #(when (= id (:id %)) %) (:items checkpoints)))

(defn undo-target
  "Checkpoint \"Undo last AI change\" goes back to, or nil."
  [checkpoints]
  (some->> (:undo-target-id checkpoints) (find-checkpoint checkpoints)))

(defn other-file?
  "True when the checkpoint saved a design version of another file than
  `file-id`; the daemon refuses to restore it from this file."
  [checkpoint file-id]
  (let [version-file-id (get-in checkpoint [:file-version :file-id])]
    (and (some? version-file-id)
         (not= (str file-id) version-file-id))))

(defn code-only?
  "True when the checkpoint has no design version."
  [checkpoint]
  (nil? (:file-version checkpoint)))

(defn workflow-label
  "Plain name of the workflow that saved a checkpoint."
  [workflow]
  (case workflow
    "manual"             (tr "penforge.checkpoints.workflow.manual")
    "checkpoint-restore" (tr "penforge.checkpoints.workflow.restore")
    "fix-comment"        (tr "penforge.checkpoints.workflow.fix-comments")
    "fix-comments"       (tr "penforge.checkpoints.workflow.fix-comments")
    "generate-screen"    (tr "penforge.checkpoints.workflow.generate-screen")
    "adapt-responsive"   (tr "penforge.checkpoints.workflow.adapt-responsive")
    "auto-name"          (tr "penforge.checkpoints.workflow.auto-name")
    "cleanup-import"     (tr "penforge.checkpoints.workflow.cleanup-import")
    "build-run"          (tr "penforge.checkpoints.workflow.build")
    "design-md-import"   (tr "penforge.checkpoints.workflow.design-md")
    "token-sync"         (tr "penforge.checkpoints.workflow.token-sync")
    (tr "penforge.checkpoints.workflow.other" (str workflow))))

(defn run-outcome
  "Reduce the messages of one workflow run (see `chat/workflow-messages`)
  to `{:done :ok :result :summary :error}`."
  [outcome {:keys [type kind payload ok summary error code message]}]
  (case type
    "workflow.event" (if (= "result" kind) (assoc outcome :result payload) outcome)
    "workflow.done"  (assoc outcome :done true :ok (boolean ok) :summary summary :error error)
    "error"          (assoc outcome :done true :ok false :error (or message code))
    outcome))

;; --- Events

(defn- connected?
  [state]
  (= :connected (get-in state [:penforge :connection :status])))

(defn- update-checkpoints
  [state f & args]
  (apply update-in state state-path (fnil f empty-state) args))

(defn- run-silent
  "Start a workflow without a chat line; returns a stream with the event
  that starts it, then one `run-outcome` map once the run ends (`:done`
  false when the connection dropped first)."
  [stream name params]
  (let [rid (proto/next-rid)]
    (rx/merge
     (rx/of (chat/run-workflow name params {:rid rid :silent true}))
     (->> (chat/workflow-messages stream rid)
          (rx/take-until (rx/filter (ptk/type? ::client/socket-closed) stream))
          (rx/reduce run-outcome {:done false})))))

(defn- outcome?
  [value]
  (and (map? value) (contains? value :done)))

(defn- not-connected-error
  []
  (ntf/error (tr "penforge.checkpoints.not-connected")))

(defn- checkpoints-loaded
  [listing]
  (ptk/reify ::checkpoints-loaded
    ptk/UpdateEvent
    (update [_ state]
      (update-checkpoints state apply-listing listing))))

(defn- checkpoints-failed
  []
  (ptk/reify ::checkpoints-failed
    ptk/UpdateEvent
    (update [_ state]
      (update-checkpoints state assoc :status :error))))

(defn- set-busy
  [busy]
  (ptk/reify ::set-busy
    ptk/UpdateEvent
    (update [_ state]
      (update-checkpoints state assoc :busy busy))))

(defn fetch-checkpoints
  "Load the checkpoints of the project from the daemon."
  []
  (ptk/reify ::fetch-checkpoints
    ptk/UpdateEvent
    (update [_ state]
      (if (connected? state)
        (update-checkpoints state assoc :status :loading)
        (update-checkpoints state assoc :status :error)))

    ptk/WatchEvent
    (watch [_ state stream]
      (if (connected? state)
        (->> (run-silent stream "checkpoint-list" {})
             (rx/map (fn [value]
                       (cond
                         (not (outcome? value))
                         value

                         (and (:ok value) (map? (:result value)))
                         (checkpoints-loaded (:result value))

                         :else
                         (checkpoints-failed)))))
        (rx/empty)))))

(defn- restore-finished
  [{:keys [done ok result error]}]
  (let [{:keys [checkpoint design cancelled]} result
        label (:label checkpoint)]
    (rx/concat
     (rx/of (set-busy nil))
     (cond
       (and ok cancelled)
       (rx/empty)

       (and ok (= "missing" design))
       (rx/of (ntf/warn (tr "penforge.checkpoints.restored-code-only" label)))

       ok
       (rx/of (ntf/success (tr "penforge.checkpoints.restored" label)))

       (not done)
       (rx/of (ntf/error (tr "penforge.checkpoints.connection-lost")))

       :else
       (rx/of (ntf/error (tr "penforge.checkpoints.restore-failed" (str error)))))
     (rx/of (fetch-checkpoints)))))

(defn restore-checkpoint
  "Go back to a checkpoint (`{:id id}`) after the user agreed; the
  daemon saves the current state first, so this can be undone."
  [{:keys [id]}]
  (ptk/reify ::restore-checkpoint
    ptk/UpdateEvent
    (update [_ state]
      (if (connected? state)
        (update-checkpoints state assoc :busy id)
        state))

    ptk/WatchEvent
    (watch [_ state stream]
      (if (connected? state)
        (->> (run-silent stream "checkpoint-restore" {:id id :confirmed true})
             (rx/mapcat (fn [value]
                          (if (outcome? value)
                            (restore-finished value)
                            (rx/of value)))))
        (rx/of (not-connected-error))))))

(defn- confirm-undo
  [checkpoint]
  (modal/show :confirm
              {:title (tr "penforge.checkpoints.undo.title")
               :message (tr "penforge.checkpoints.undo.message" (:label checkpoint))
               :scd-message (tr "penforge.checkpoints.restore.warning")
               :accept-label (tr "penforge.checkpoints.undo.accept")
               :cancel-label (tr "penforge.checkpoints.restore.cancel")
               :accept-style :primary
               :on-accept #(st/emit! (restore-checkpoint {:id (:id checkpoint)}))}))

(defn undo-last
  "\"Undo last AI change\": ask, then go back to the checkpoint saved
  before the newest AI change not undone yet."
  []
  (ptk/reify ::undo-last
    ptk/WatchEvent
    (watch [_ state stream]
      (if (connected? state)
        (let [file-id (:current-file-id state)]
          (->> (run-silent stream "checkpoint-list" {})
               (rx/mapcat
                (fn [value]
                  (if-not (outcome? value)
                    (rx/of value)
                    (let [{:keys [ok result]} value]
                      (if-not (and ok (map? result))
                        (rx/of (checkpoints-failed)
                               (ntf/error (tr "penforge.checkpoints.load-failed")))
                        (let [target (undo-target (apply-listing empty-state result))]
                          (rx/of (checkpoints-loaded result)
                                 (cond
                                   (nil? target)
                                   (ntf/info (tr "penforge.checkpoints.undo.nothing"))

                                   (other-file? target file-id)
                                   (ntf/info (tr "penforge.checkpoints.undo.other-file"
                                                 (or (get-in target [:file-version :file-name])
                                                     (get-in target [:file-version :file-id]))))

                                   :else
                                   (confirm-undo target)))))))))))
        (rx/of (not-connected-error))))))

(defn create-checkpoint
  "Save a checkpoint by hand."
  []
  (ptk/reify ::create-checkpoint
    ptk/UpdateEvent
    (update [_ state]
      (if (connected? state)
        (update-checkpoints state assoc :busy :create)
        state))

    ptk/WatchEvent
    (watch [_ state stream]
      (if (connected? state)
        (->> (run-silent stream "checkpoint-create"
                         {:label (tr "penforge.checkpoints.manual-label")
                          :workflow "manual"})
             (rx/mapcat
              (fn [value]
                (if-not (outcome? value)
                  (rx/of value)
                  (rx/of (set-busy nil)
                         (if (:ok value)
                           (ntf/success (tr "penforge.checkpoints.created"))
                           (ntf/error (tr "penforge.checkpoints.create-failed")))
                         (fetch-checkpoints))))))
        (rx/of (not-connected-error))))))

(defn- set-diff
  [id diff]
  (ptk/reify ::set-diff
    ptk/UpdateEvent
    (update [_ state]
      (update-checkpoints state assoc-in [:diffs id] diff))))

(defn fetch-diff
  "Load the code changes made since a checkpoint (developer persona)."
  [id]
  (ptk/reify ::fetch-diff
    ptk/UpdateEvent
    (update [_ state]
      (update-checkpoints state assoc-in [:diffs id] {:status :loading}))

    ptk/WatchEvent
    (watch [_ state stream]
      (if (connected? state)
        (->> (run-silent stream "checkpoint-diff" {:id id})
             (rx/map (fn [value]
                       (cond
                         (not (outcome? value)) value
                         (and (:ok value) (map? (:result value)))
                         (set-diff id {:status :loaded :data (:result value)})
                         :else
                         (set-diff id {:status :error :error (:error value)})))))
        (rx/of (set-diff id {:status :error}))))))

(defn hide-diff
  [id]
  (ptk/reify ::hide-diff
    ptk/UpdateEvent
    (update [_ state]
      (update-checkpoints state update :diffs dissoc id))))

(defn open-history
  "Show the AI history dialog and load the checkpoints."
  []
  (ptk/reify ::open-history
    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (modal/show modal-type {})
             (fetch-checkpoints)))))

;; --- Actions

(actions/register-action!
 {:id :ai/checkpoints
  :label #(tr "penforge.actions.checkpoints")
  :icon i/history
  :order 80
  :scopes #{:main-menu :command-palette}
  :run (fn [_] (st/emit! (open-history)))})

(actions/register-action!
 {:id :ai/undo-last
  :label #(tr "penforge.actions.undo-last")
  :icon i/arrow-left
  :order 81
  :scopes #{:header :main-menu :command-palette}
  :enabled? connected?
  :run (fn [_] (st/emit! (undo-last)))})
