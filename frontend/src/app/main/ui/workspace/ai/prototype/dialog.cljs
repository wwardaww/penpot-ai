;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.prototype.dialog
  "Wire prototype dialog (W27): runs the daemon workflow
  `wire-prototype` for a page (or the selected screens), lists the
  proposed links and the flow with checkboxes, and applies the checked
  ones with a second run (`:apply true`). The plugin applies them as
  one undo step and never replaces an existing interaction.

  The dialog state lives in a local atom created once per mount (see
  the auto-name dialog for why not `mf/use-state`)."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.chat :as chat]
   [app.main.data.modal :as modal]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.controls.checkbox :refer [checkbox*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.main.ui.ds.notifications.context-notification :refer [context-notification*]]
   [app.main.ui.ds.product.loader :refer [loader*]]
   [app.util.i18n :as i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

;; --- Pure helpers

(defn propose-params
  "Params of the proposal run."
  [{:keys [page-id board-ids]}]
  (cond-> {}
    (some? page-id) (assoc :page-id page-id)
    (seq board-ids) (assoc :board-ids (vec board-ids))))

(defn link-key
  "Key of a proposed link in the `:checked` set."
  [link]
  (:source-id link))

(defn- proposal-state
  [state {:keys [links flow page-id reason]}]
  (let [links (vec links)]
    (assoc state
           :page-id (or page-id (:page-id state))
           :links links
           :flow flow
           :reason reason
           :checked (into #{} (map link-key) links)
           :flow-checked (some? flow))))

(defn next-state
  "Dialog state after a daemon message of the current run."
  [state {:keys [type kind payload ok summary error code message run-id]}]
  (cond
    (= type "workflow.started")
    (assoc state :run-id run-id)

    (and (= type "workflow.event") (= kind "result") (= "proposal" (:mode payload)))
    (proposal-state state payload)

    (and (= type "workflow.event") (= kind "result") (= "applied" (:mode payload)))
    (assoc state :results (vec (:results payload)))

    (= type "workflow.done")
    (let [state (dissoc state :run-id)]
      (cond
        (not ok)
        (assoc state :step :error :error (or error summary))

        (= (:step state) :applying)
        (assoc state :step :done)

        (or (seq (:links state)) (:flow state))
        (assoc state :step :review)

        :else
        (assoc state :step :empty)))

    (= type "error")
    (-> state
        (assoc :step :error :error (or message code))
        (dissoc :run-id))

    :else
    state))

(defn accepted
  "Checked links and flow, ready for the apply run."
  [{:keys [links checked flow flow-checked]}]
  {:links (filterv #(contains? checked (link-key %)) links)
   :flow (when flow-checked flow)})

(defn apply-params
  "Params of the apply run for the checked links and flow."
  [{:keys [page-id] :as state}]
  (let [{:keys [links flow]} (accepted state)]
    (cond-> {:apply true
             :links (mapv #(select-keys % [:source-id :action :destination-id]) links)}
      (some? flow)    (assoc :flow (select-keys flow [:name :starting-board-id]))
      (some? page-id) (assoc :page-id page-id))))

(defn result-counts
  "Counts of the apply results: `{:wired n :kept n :flow bool}`.
  `:kept` are links the plugin left alone because the layer already
  had one."
  [results]
  (let [links (remove #(= "set-flow" (:op %)) results)
        count-of (fn [status] (count (filter #(= status (:status %)) links)))]
    {:wired (+ (count-of "added") (count-of "updated"))
     :kept  (count-of "conflict")
     :flow  (boolean (some #(and (= "set-flow" (:op %))
                                 (not= "skipped" (:status %)))
                           results))}))

(defn link-label
  "One line describing a link: \"Home › Add Button → Add Task\"."
  [{:keys [action board-name source-name destination-name]}]
  (let [target (case action
                 "previous-screen" (tr "penforge.prototype.action.back")
                 "close-overlay"   (tr "penforge.prototype.action.close")
                 "open-overlay"    (tr "penforge.prototype.action.overlay" destination-name)
                 destination-name)]
    (str board-name " › " source-name " → " target)))

;; --- Components

(def ref:connected
  "True while the AI client is paired with the daemon."
  (l/derived #(= :connected (get-in % [:penforge :connection :status])) st/state))

(mf/defc review-step*
  {::mf/private true}
  [{:keys [state on-toggle on-toggle-flow]}]
  (let [{:keys [links checked flow flow-checked]} state]
    [:div {:class (stl/css :review)}
     [:> text* {:as "p" :typography t/body-small :class (stl/css :hint)}
      (tr "penforge.prototype.review-hint")]
     [:ul {:class (stl/css :rows)}
      (for [link links]
        (let [k (link-key link)]
          [:li {:key k :class (stl/css :row)}
           [:> checkbox* {:id (str "penforge-wire-" k)
                          :label (link-label link)
                          :checked (contains? checked k)
                          :on-change #(on-toggle k)}]
           (when (seq (:reason link))
             [:> text* {:as "span" :typography t/body-small :class (stl/css :reason)}
              (:reason link)])]))
      (when flow
        [:li {:key "flow" :class (stl/css :row)}
         [:> checkbox* {:id "penforge-wire-flow"
                        :label (tr "penforge.prototype.flow" (:name flow) (:starting-board-name flow))
                        :checked (boolean flow-checked)
                        :on-change on-toggle-flow}]])]]))

(mf/defc message-step*
  {::mf/private true}
  [{:keys [state]}]
  (let [{:keys [step error results reason]} state
        {:keys [wired kept flow]} (result-counts results)]
    (case step
      :done
      [:div {:class (stl/css :messages)}
       [:> context-notification* {:level :success :appearance :ghost}
        (tr "penforge.prototype.done" (i18n/c wired))]
       (when flow
         [:> text* {:as "p" :typography t/body-small :class (stl/css :hint)}
          (tr "penforge.prototype.done-flow")])
       (when (pos? kept)
         [:> text* {:as "p" :typography t/body-small :class (stl/css :hint)}
          (tr "penforge.prototype.kept" (i18n/c kept))])
       [:> text* {:as "p" :typography t/body-small :class (stl/css :hint)}
        (tr "penforge.prototype.play-hint")]]

      :empty
      [:> context-notification* {:level :info :appearance :ghost}
       (if (= reason "needs-two-screens")
         (tr "penforge.prototype.needs-two-screens")
         (tr "penforge.prototype.none"))]

      [:> context-notification* {:level :error :appearance :ghost}
       (cond
         (= error "busy")      (tr "penforge.prototype.error.busy")
         (= error "cancelled") (tr "penforge.prototype.error.cancelled")
         :else                 (tr "penforge.prototype.error" (str error)))])))

(mf/defc wire-prototype-dialog
  "Modal `:penforge-wire-prototype`. Props: `:page-id` and `:board-ids`
  (strings)."
  {::mf/register modal/components
   ::mf/register-as :penforge-wire-prototype}
  [{:keys [page-id board-ids]}]
  (let [connected (mf/deref ref:connected)

        state*  (mf/with-memo [] (atom {:step :running :page-id page-id}))
        state   (mf/deref state*)
        step    (:step state)

        subscription (mf/use-ref nil)

        start!
        (mf/use-fn
         (mf/deps state*)
         (fn [params]
           (let [rid (str (random-uuid))]
             (some-> (mf/ref-val subscription) rx/dispose!)
             (mf/set-ref-val! subscription
                              (rx/subs! #(swap! state* next-state %)
                                        (chat/workflow-messages st/stream rid)))
             (st/emit! (chat/run-workflow "wire-prototype" params {:rid rid :silent true})))))

        handle-toggle
        (mf/use-fn
         (mf/deps state*)
         (fn [k]
           (swap! state* update :checked
                  #(if (contains? % k) (disj % k) (conj % k)))))

        handle-toggle-flow
        (mf/use-fn
         (mf/deps state*)
         (fn [_]
           (swap! state* update :flow-checked not)))

        handle-apply
        (mf/use-fn
         (mf/deps state* start!)
         (fn [_]
           (let [params (apply-params @state*)]
             (swap! state* assoc :step :applying)
             (start! params))))

        handle-close
        (mf/use-fn (fn [_] (modal/hide!)))

        handle-open-chat
        (mf/use-fn
         (fn [_]
           (modal/hide!)
           (st/emit! (chat/open-chat))))

        {:keys [links flow]} (when (= step :review) (accepted state))
        selected (+ (count links) (if flow 1 0))]

    ;; propose as soon as the dialog opens
    (mf/with-effect [connected]
      (when (and connected (= :running (:step @state*)) (nil? (mf/ref-val subscription)))
        (start! (propose-params {:page-id page-id :board-ids board-ids}))))

    ;; closing the dialog stops a run still going
    (mf/with-effect [state*]
      (fn []
        (some-> (mf/ref-val subscription) rx/dispose!)
        (when-let [run-id (:run-id @state*)]
          (st/emit! (chat/cancel-workflow run-id)))))

    [:div {:class (stl/css :modal-overlay)}
     [:div {:class (stl/css :modal-dialog)
            :role "dialog"
            :aria-labelledby "penforge-wire-prototype-title"}
      [:> icon-button* {:variant "ghost"
                        :tooltip-class (stl/css :close-btn)
                        :aria-label (tr "labels.close")
                        :icon i/close
                        :on-click handle-close}]
      [:div {:class (stl/css :modal-title) :id "penforge-wire-prototype-title"}
       (tr "penforge.prototype.title")]

      [:div {:class (stl/css :modal-content)}
       (cond
         (not connected)
         [:> context-notification* {:level :warning :appearance :ghost}
          (tr "penforge.prototype.not-connected")]

         (#{:running :applying} step)
         [:div {:class (stl/css :progress)}
          [:> loader* {:width 32 :title (tr "penforge.prototype.running")}]
          [:> text* {:as "p" :typography t/body-medium}
           (if (= step :applying)
             (tr "penforge.prototype.applying")
             (tr "penforge.prototype.running"))]]

         (= step :review)
         [:> review-step* {:state state
                           :on-toggle handle-toggle
                           :on-toggle-flow handle-toggle-flow}]

         :else
         [:> message-step* {:state state}])]

      [:div {:class (stl/css :modal-footer)}
       (cond
         (not connected)
         [:*
          [:> button* {:variant "secondary" :on-click handle-close} (tr "labels.cancel")]
          [:> button* {:variant "primary" :on-click handle-open-chat}
           (tr "penforge.prototype.open-ai")]]

         (#{:running :applying} step)
         [:> button* {:variant "secondary" :on-click handle-close} (tr "labels.cancel")]

         (= step :review)
         [:*
          [:> button* {:variant "secondary" :on-click handle-close} (tr "labels.cancel")]
          [:> button* {:variant "primary"
                       :disabled (zero? selected)
                       :on-click handle-apply}
           (tr "penforge.prototype.apply" (i18n/c selected))]]

         :else
         [:> button* {:variant "primary" :on-click handle-close} (tr "labels.close")])]]]))
