;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.auto-name.dialog
  "Auto-name dialog (W16): pick the layers and the naming style, run
  the daemon workflow `auto-name`, review the proposed names (old →
  new, with checkboxes and editable names) and apply the accepted
  ones through the `:on-apply` callback."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.chat :as chat]
   [app.main.data.modal :as modal]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.controls.checkbox :refer [checkbox*]]
   [app.main.ui.ds.controls.input :refer [input*]]
   [app.main.ui.ds.controls.radio-buttons :refer [radio-buttons*]]
   [app.main.ui.ds.controls.select :refer [select*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.main.ui.ds.notifications.context-notification :refer [context-notification*]]
   [app.main.ui.ds.product.loader :refer [loader*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

;; --- Pure helpers

(defn workflow-params
  "Params of the `auto-name` workflow for the dialog choices."
  [{:keys [scope node-ids page-id convention include-components]}]
  (cond-> {:scope (name scope)
           :convention (name (or convention :title))
           :include-components (boolean include-components)}
    (= scope :selection)
    (assoc :node-ids (vec node-ids))

    (and (not= scope :selection) (some? page-id))
    (assoc :page-id page-id)))

(defn next-state
  "Dialog state after a daemon message of the run (see
  `app.main.data.ai.chat/workflow-messages`)."
  [state {:keys [type kind payload ok summary error code message run-id]}]
  (cond
    (= type "workflow.started")
    (assoc state :run-id run-id)

    (and (= type "workflow.event") (= kind "progress") (some? (:stage payload)))
    (assoc state :progress (select-keys payload [:stage :done :total]))

    (and (= type "workflow.event") (= kind "result"))
    (let [renames (vec (:renames payload))]
      (assoc state
             :result (dissoc payload :renames)
             :renames renames
             :checked (into #{} (map :node-id) renames)
             :edits {}))

    (= type "workflow.done")
    (if ok
      (assoc state
             :step (if (seq (:renames state)) :review :empty)
             :run-id nil)
      (assoc state
             :step :error
             :error (or error summary)
             :run-id nil))

    (= type "error")
    (assoc state :step :error :error (or message code))

    :else
    state))

(defn accepted-renames
  "Checked renames, with the names the user edited."
  [{:keys [renames checked edits]}]
  (into []
        (comp (filter #(contains? checked (:node-id %)))
              (map (fn [{:keys [node-id] :as rename}]
                     (if-let [edited (get edits node-id)]
                       (assoc rename :new-name edited)
                       rename)))
              (remove #(empty? (:new-name %))))
        renames))

;; --- Components

(def ref:connected
  "True while the AI client is paired with the daemon."
  (l/derived #(= :connected (get-in % [:penforge :connection :status])) st/state))

(mf/defc progress-line*
  {::mf/private true}
  [{:keys [progress]}]
  (let [{:keys [stage done total]} progress]
    [:div {:class (stl/css :progress)}
     [:> loader* {:width 32 :title (tr "penforge.auto-name.running")}]
     [:> text* {:as "p" :typography t/body-medium}
      (if (and (= stage "name") (pos? (or total 0)))
        (tr "penforge.auto-name.progress" (or done 0) total)
        (tr "penforge.auto-name.running"))]]))

(mf/defc rename-row*
  {::mf/private true}
  [{:keys [rename checked edited on-toggle on-edit]}]
  (let [{:keys [node-id old-name new-name]} rename
        checkbox-id (str "penforge-auto-name-" node-id)

        handle-toggle
        (mf/use-fn
         (mf/deps node-id on-toggle)
         (fn [_] (on-toggle node-id)))

        handle-edit
        (mf/use-fn
         (mf/deps node-id on-edit)
         (fn [event]
           (on-edit node-id (dom/get-target-val event))))]

    [:li {:class (stl/css :row)}
     [:> checkbox* {:id checkbox-id
                    :checked checked
                    :aria-label old-name
                    :on-change handle-toggle}]
     [:span {:class (stl/css :old-name) :title old-name} old-name]
     [:> icon* {:icon-id i/arrow-right :size "s" :class (stl/css :arrow)}]
     [:> input* {:class (stl/css :new-name)
                 :variant "dense"
                 :aria-label (tr "penforge.auto-name.new-name" old-name)
                 :value (or edited new-name)
                 :disabled (not checked)
                 :on-change handle-edit}]]))

(mf/defc setup-step*
  {::mf/private true}
  [{:keys [options has-selection developer on-change]}]
  (let [{:keys [scope convention include-components]} options

        scope-options
        (mf/with-memo [has-selection]
          [{:id "penforge-auto-name-scope-selection"
            :label (tr "penforge.auto-name.scope.selection")
            :value "selection"
            :disabled (not has-selection)}
           {:id "penforge-auto-name-scope-page"
            :label (tr "penforge.auto-name.scope.page")
            :value "page"}
           {:id "penforge-auto-name-scope-file"
            :label (tr "penforge.auto-name.scope.file")
            :value "file"}])

        convention-options
        (mf/with-memo []
          [{:id "title" :label (tr "penforge.auto-name.convention.title")}
           {:id "kebab" :label (tr "penforge.auto-name.convention.kebab")}
           {:id "bem" :label (tr "penforge.auto-name.convention.bem")}])

        handle-scope
        (mf/use-fn
         (mf/deps on-change)
         (fn [value _]
           (when value
             (on-change :scope (keyword value)))))

        handle-convention
        (mf/use-fn
         (mf/deps on-change)
         (fn [id]
           (on-change :convention (keyword id))))

        handle-components
        (mf/use-fn
         (mf/deps on-change include-components)
         (fn [_]
           (on-change :include-components (not include-components))))]

    [:div {:class (stl/css :setup)}
     [:> text* {:as "p" :typography t/body-medium :class (stl/css :description)}
      (tr "penforge.auto-name.description")]

     [:div {:class (stl/css :field)}
      [:> text* {:as "span" :typography t/body-small :class (stl/css :label)}
       (tr "penforge.auto-name.scope")]
      [:> radio-buttons* {:name "penforge-auto-name-scope"
                          :selected (name scope)
                          :options scope-options
                          :on-change handle-scope}]]

     (when developer
       [:div {:class (stl/css :field)}
        [:> text* {:as "span" :typography t/body-small :class (stl/css :label)}
         (tr "penforge.auto-name.convention")]
        [:> select* {:options convention-options
                     :default-selected (name convention)
                     :on-change handle-convention}]])

     [:> checkbox* {:id "penforge-auto-name-components"
                    :label (tr "penforge.auto-name.include-components")
                    :checked (boolean include-components)
                    :on-change handle-components}]]))

(mf/defc review-step*
  {::mf/private true}
  [{:keys [state on-toggle on-toggle-all on-edit]}]
  (let [{:keys [renames checked edits result]} state
        all-checked (= (count checked) (count renames))
        remaining   (or (:remaining result) 0)]
    [:div {:class (stl/css :review)}
     [:div {:class (stl/css :review-header)}
      [:> checkbox* {:id "penforge-auto-name-all"
                     :label (tr "penforge.auto-name.select-all" (count renames))
                     :checked all-checked
                     :on-change on-toggle-all}]]
     [:ul {:class (stl/css :rows)}
      (for [{:keys [node-id] :as rename} renames]
        [:> rename-row* {:key node-id
                         :rename rename
                         :checked (contains? checked node-id)
                         :edited (get edits node-id)
                         :on-toggle on-toggle
                         :on-edit on-edit}])]
     (when (pos? remaining)
       [:> text* {:as "p" :typography t/body-small :class (stl/css :hint)}
        (tr "penforge.auto-name.remaining" remaining)])]))

(mf/defc message-step*
  {::mf/private true}
  [{:keys [state]}]
  (let [{:keys [step error applied result]} state
        skipped (or (:skipped-components result) 0)]
    (cond
      (= step :done)
      [:> context-notification* {:level :success :appearance :ghost}
       (tr "penforge.auto-name.done" applied)]

      (= step :empty)
      [:div {:class (stl/css :messages)}
       [:> context-notification* {:level :info :appearance :ghost}
        (tr "penforge.auto-name.none")]
       (when (pos? skipped)
         [:> text* {:as "p" :typography t/body-small :class (stl/css :hint)}
          (tr "penforge.auto-name.skipped-components" skipped)])]

      :else
      [:> context-notification* {:level :error :appearance :ghost}
       (tr "penforge.auto-name.error" (str error))])))

(mf/defc auto-name-dialog
  "Modal `:penforge-auto-name`. Props: `:scope` (`:selection` or
  `:page`), `:node-ids`, `:page-id` (strings), `:persona` and
  `:on-apply` (fn of the accepted renames)."
  {::mf/register modal/components
   ::mf/register-as :penforge-auto-name}
  [{:keys [scope node-ids page-id persona on-apply]}]
  (let [connected     (mf/deref ref:connected)
        developer     (= persona :developer)
        has-selection (boolean (seq node-ids))

        state*  (mf/use-state
                 #(hash-map :step :setup
                            :options {:scope (if (and (= scope :selection) has-selection)
                                               :selection
                                               :page)
                                      :convention :title
                                      :include-components false}))
        state   (deref state*)
        step    (:step state)

        subscription (mf/use-ref nil)

        handle-option
        (mf/use-fn
         (fn [key value]
           (swap! state* assoc-in [:options key] value)))

        start
        (mf/use-fn
         (mf/deps node-ids page-id on-apply)
         (fn [apply-all]
           (let [rid    (str (random-uuid))
                 params (workflow-params (assoc (:options @state*)
                                                :node-ids node-ids
                                                :page-id page-id))]
             (swap! state* assoc :step :running :apply-all apply-all :progress nil)
             ;; subscribe before the request goes out
             (some-> (mf/ref-val subscription) rx/dispose!)
             (mf/set-ref-val!
              subscription
              (->> (chat/workflow-messages st/stream rid)
                   (rx/subs!
                    (fn [message]
                      (let [next (swap! state* next-state message)]
                        (when (and (:apply-all next) (= :review (:step next)))
                          (let [renames (accepted-renames next)]
                            (on-apply renames)
                            (swap! state* assoc :step :done :applied (count renames)))))))))
             (st/emit! (chat/run-workflow "auto-name" params {:rid rid :silent true})))))

        handle-preview
        (mf/use-fn (mf/deps start) #(start false))

        handle-apply-all
        (mf/use-fn (mf/deps start) #(start true))

        handle-toggle
        (mf/use-fn
         (fn [node-id]
           (swap! state* update :checked
                  #(if (contains? % node-id) (disj % node-id) (conj % node-id)))))

        handle-toggle-all
        (mf/use-fn
         (fn [_]
           (swap! state* (fn [{:keys [renames checked] :as state}]
                           (assoc state :checked
                                  (if (= (count checked) (count renames))
                                    #{}
                                    (into #{} (map :node-id) renames)))))))

        handle-edit
        (mf/use-fn
         (fn [node-id value]
           (swap! state* assoc-in [:edits node-id] value)))

        handle-apply
        (mf/use-fn
         (mf/deps on-apply)
         (fn [_]
           (let [renames (accepted-renames @state*)]
             (on-apply renames)
             (swap! state* assoc :step :done :applied (count renames)))))

        ;; the unmount effect below stops a running workflow
        handle-close
        (mf/use-fn
         (fn [_]
           (modal/hide!)))

        handle-open-chat
        (mf/use-fn
         (fn [_]
           (modal/hide!)
           (st/emit! (chat/open-chat))))

        accepted (when (= step :review) (count (accepted-renames state)))]

    ;; closing the dialog (also with Escape or a click outside) stops
    ;; a run still going
    (mf/with-effect []
      (fn []
        (some-> (mf/ref-val subscription) rx/dispose!)
        (when-let [run-id (:run-id @state*)]
          (st/emit! (chat/cancel-workflow run-id)))))

    [:div {:class (stl/css :modal-overlay)}
     [:div {:class (stl/css :modal-dialog)
            :role "dialog"
            :aria-labelledby "penforge-auto-name-title"}
      [:> icon-button* {:variant "ghost"
                        :tooltip-class (stl/css :close-btn)
                        :aria-label (tr "labels.close")
                        :icon i/close
                        :on-click handle-close}]
      [:div {:class (stl/css :modal-title) :id "penforge-auto-name-title"}
       (tr "penforge.auto-name.title")]

      [:div {:class (stl/css :modal-content)}
       (cond
         (not connected)
         [:> context-notification* {:level :warning :appearance :ghost}
          (tr "penforge.auto-name.not-connected")]

         (= step :setup)
         [:> setup-step* {:options (:options state)
                          :has-selection has-selection
                          :developer developer
                          :on-change handle-option}]

         (= step :running)
         [:> progress-line* {:progress (:progress state)}]

         (= step :review)
         [:> review-step* {:state state
                           :on-toggle handle-toggle
                           :on-toggle-all handle-toggle-all
                           :on-edit handle-edit}]

         :else
         [:> message-step* {:state state}])]

      [:div {:class (stl/css :modal-footer)}
       (cond
         (not connected)
         [:*
          [:> button* {:variant "secondary" :on-click handle-close} (tr "labels.cancel")]
          [:> button* {:variant "primary" :on-click handle-open-chat}
           (tr "penforge.auto-name.open-ai")]]

         (= step :setup)
         [:*
          [:> button* {:variant "secondary" :on-click handle-close} (tr "labels.cancel")]
          (when-not developer
            [:> button* {:variant "secondary" :on-click handle-apply-all}
             (tr "penforge.auto-name.apply-all")])
          [:> button* {:variant "primary" :on-click handle-preview}
           (tr "penforge.auto-name.preview")]]

         (= step :running)
         [:> button* {:variant "secondary" :on-click handle-close} (tr "labels.cancel")]

         (= step :review)
         [:*
          [:> button* {:variant "secondary" :on-click handle-close} (tr "labels.cancel")]
          [:> button* {:variant "primary"
                       :disabled (zero? accepted)
                       :on-click handle-apply}
           (tr "penforge.auto-name.apply" accepted)]]

         :else
         [:> button* {:variant "primary" :on-click handle-close} (tr "labels.close")])]]]))
