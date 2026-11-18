;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.cleanup
  "AI action that tidies up a messy page or selection (W17).

  The daemon workflow `cleanup-import` saves a checkpoint, removes
  unused layers, gives lined-up layers flex/grid layouts, makes
  components from look-alike items (each step one undo block, checked
  with screenshots and taken back when the look changes) and names
  the layers. The run shows in the AI chat; this namespace translates
  its progress codes and builds the summary from the `result`
  payload."
  (:require
   [app.common.data :as d]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.helpers :as dsh]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.i18n :as i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [clojure.string :as str]
   [potok.v2.core :as ptk]))

(def workflow-name
  "cleanup-import")

(defn can-edit?
  "Whether the profile may change the open file."
  [state]
  (boolean
   (and (get-in (dsh/lookup-team state) [:permissions :can-edit])
        (not (get-in state [:workspace-global :read-only?])))))

(defn workflow-params
  "Params of a run: the selected layers, or the whole current page."
  [state selected]
  (let [page-id (:current-page-id state)]
    (if (seq selected)
      {:scope "selection"
       :node-ids (mapv str selected)
       :page-id (some-> page-id str)}
      {:scope "page"
       :page-id (some-> page-id str)})))

;; --- Translated texts of a run

(defn progress-text
  "Translated text of a progress payload (`step` + `params`, or the
  `stage` of the auto-naming), or nil for unknown steps."
  [{:keys [step stage params]}]
  (let [board (:board params)
        name  (:name params)]
    (cond
      (some? stage)             (tr "penforge.cleanup.progress.names")
      (= step "scan")           (tr "penforge.cleanup.progress.scan")
      (= step "checkpoint")     (tr "penforge.cleanup.progress.checkpoint")
      (= step "review")         (tr "penforge.cleanup.progress.review")
      (= step "junk")           (tr "penforge.cleanup.progress.junk" (or board ""))
      (= step "layout")         (tr "penforge.cleanup.progress.layout" (or board ""))
      (= step "components")     (tr "penforge.cleanup.progress.components" (or name ""))
      (= step "names")          (tr "penforge.cleanup.progress.names")
      :else                     nil)))

(defn error-text
  "Translated text of a failed run's error (`cleanup/<code>`), or nil."
  [error]
  (let [code (when (string? error)
               (second (re-find #"^cleanup/([a-z-]+)" error)))]
    (case code
      "no-selection"      (tr "penforge.cleanup.error.no-selection")
      "no-page"           (tr "penforge.cleanup.error.no-page")
      "read-failed"       (tr "penforge.cleanup.error.read-failed")
      "checkpoint-failed" (tr "penforge.cleanup.error.checkpoint-failed")
      "busy"              (tr "penforge.cleanup.error.busy")
      "plan-changed"      (tr "penforge.cleanup.error.plan-changed")
      nil)))

(defn hidden-question
  "Translated question about hidden layers (`plan` payload
  `{:code \"hidden\" :count :names}`)."
  [{n :count names :names}]
  (tr "penforge.cleanup.hidden.question"
      (i18n/c (or n 0))
      (str/join ", " names)))

(defn option-label
  "Translated label of a question option, or nil for unknown ids."
  [id]
  (case id
    "keep"   (tr "penforge.cleanup.hidden.keep")
    "delete" (tr "penforge.cleanup.hidden.delete")
    nil))

(defn summary-text
  "Translated summary of a run from its `result` payload."
  [{:keys [page-name totals checkpoint notes hidden stopped]}]
  (let [{:keys [junk layouts layouts-reverted components
                components-reverted renamed]} totals
        junk       (or junk 0)
        layouts    (or layouts 0)
        components (or components 0)
        renamed    (or renamed 0)
        reverted   (+ (or layouts-reverted 0) (or components-reverted 0))
        changed?   (pos? (+ junk layouts components renamed))
        kept       (- (or (:count hidden) 0) (or (:removed hidden) 0))
        parts      (cond-> [(if changed?
                              (tr "penforge.cleanup.summary.title" (or page-name ""))
                              (tr "penforge.cleanup.summary.nothing"))]
                     (pos? junk)       (conj (tr "penforge.cleanup.summary.junk" (i18n/c junk)))
                     (pos? layouts)    (conj (tr "penforge.cleanup.summary.layouts" (i18n/c layouts)))
                     (pos? components) (conj (tr "penforge.cleanup.summary.components" (i18n/c components)))
                     (pos? renamed)    (conj (tr "penforge.cleanup.summary.renamed" (i18n/c renamed)))
                     (pos? reverted)   (conj (tr "penforge.cleanup.summary.reverted" (i18n/c reverted)))
                     (pos? kept)       (conj (tr "penforge.cleanup.summary.hidden-kept" (i18n/c kept)))
                     (some? stopped)   (conj (tr "penforge.cleanup.summary.stopped"))
                     (and changed? (:n checkpoint))
                     (conj (tr "penforge.cleanup.summary.checkpoint" (:n checkpoint)))
                     (not (str/blank? notes)) (conj notes))]
    (str/join " " parts)))

(defn- update-run
  "Apply `f` to the chat entry of the run and `g` to the run itself."
  [run-id f g]
  (ptk/reify ::update-run
    ptk/UpdateEvent
    (update [_ state]
      (if (some? (get-in state [:penforge :chat :entries]))
        (-> state
            (update-in [:penforge :chat :entries]
                       (fn [entries]
                         (mapv #(if (and (= :workflow (:kind %)) (= run-id (:id %)))
                                  (f %)
                                  %)
                               entries)))
            (d/update-in-when [:penforge :chat :runs run-id] g))
        state))))

(defn- update-question
  [question-id f]
  (ptk/reify ::update-question
    ptk/UpdateEvent
    (update [_ state]
      (if (some? (get-in state [:penforge :chat :entries]))
        (update-in state [:penforge :chat :entries]
                   (fn [entries]
                     (mapv #(if (and (= :question (:kind %)) (= question-id (:id %)))
                              (f %)
                              %)
                           entries)))
        state))))

(defn- translate-options
  [options]
  (mapv #(if-let [label (option-label (:id %))]
           (assoc % :label label)
           %)
        options))

(defn localize
  "Event that translates what a daemon message of the run changed in
  the chat, or nil. `result` and `plan` are the run's last payloads of
  those kinds, if any."
  [{:keys [message result plan]}]
  (let [{msg-type :type :keys [kind payload run-id ok error]} message]
    (cond
      (and (= "workflow.event" msg-type) (= "question" kind) (= "hidden" (:code plan)))
      (let [text (hidden-question plan)]
        (update-question (:question-id payload)
                         #(-> %
                              (assoc :text text)
                              (update :options translate-options))))

      (and (= "workflow.event" msg-type) (= "progress" kind))
      (when-let [text (progress-text payload)]
        (update-run run-id
                    #(assoc % :progress {:text text})
                    #(assoc % :progress {:text text})))

      (and (= "workflow.done" msg-type) ok (some? result))
      (let [summary (summary-text result)]
        (update-run run-id
                    #(assoc % :summary summary)
                    #(assoc % :summary summary)))

      (and (= "workflow.done" msg-type) (not ok))
      (when-let [text (error-text error)]
        (update-run run-id
                    #(assoc % :summary text)
                    #(assoc % :summary text)))

      :else
      nil)))

(defn- collect-run
  [acc message]
  (let [kind (when (= "workflow.event" (:type message)) (:kind message))]
    (cond-> (assoc acc :message message)
      (= "result" kind) (assoc :result (:payload message))
      (= "plan" kind)   (assoc :plan (:payload message)))))

;; --- Run

(defn tidy-up
  "Start the `cleanup-import` workflow for the selected layers (or the
  current page) and show its translated progress in the AI chat."
  ([params]
   (tidy-up params (proto/next-rid)))
  ([params rid]
   (ptk/reify ::tidy-up
     ptk/WatchEvent
     (watch [_ _ stream]
       (rx/merge
        (->> (chat/workflow-messages stream rid)
             (rx/scan collect-run {})
             (rx/map localize)
             (rx/filter some?))
        (rx/of (chat/open-chat)
               (chat/run-workflow workflow-name params {:rid rid})))))))

(defn- run-tidy-up
  [{:keys [state selected]}]
  (st/emit! (tidy-up (workflow-params state selected))))

(actions/register-action!
 {:id :ai/tidy-up
  :label #(tr "penforge.actions.tidy-up")
  :icon i/flex-grid
  :order 35
  :scopes #{:context-menu :main-menu :command-palette}
  :visible? can-edit?
  :enabled? can-edit?
  :run run-tidy-up})
