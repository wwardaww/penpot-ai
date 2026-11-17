;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.auto-name.dialog
  "Auto-name dialog (W16): pick the layers and the naming style, run
  the daemon workflow `auto-name`, review the proposed names (old →
  new, with checkboxes and editable names) and apply the accepted
  ones through the `:on-apply` callback.

  The dialog state lives in a local atom created once per mount, not
  in `mf/use-state`: callbacks and stream subscriptions read it after
  later renders, and `mf/use-state` derefs to the value of the render
  that created the closure (its `swap!` returns nothing)."
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
   [app.util.i18n :as i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
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

(defn- review-state
  [state renames]
  (assoc state
         :step :review
         :renames (vec renames)
         :checked (into #{} (map :node-id) renames)
         :edits {}))

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
    (assoc state
           :result (dissoc payload :renames)
           :renames (vec (:renames payload))
           :checked (into #{} (map :node-id) (:renames payload))
           :edits {})

    (= type "workflow.done")
    (if ok
      (-> state
          (assoc :step (if (seq (:renames state)) :review :empty))
          (dissoc :run-id))
      (-> state
          (assoc :step :error :error (or error summary))
          (dissoc :run-id)))

    (= type "error")
    (-> state
        (assoc :step :error :error (or message code))
        (dissoc :run-id))

    :else
    state))

(defn apply-all-step
  "For a \"Rename all\" run that reached the review: the renames to
  apply now and the state after them. Names that replace a real word
  (`:ambiguous`) are never applied blindly: they stay for review."
  [state]
  (let [{plain false ambiguous true} (group-by #(boolean (:ambiguous %)) (:renames state))
        applied (+ (or (:applied state) 0) (count plain))]
    {:apply (vec plain)
     :state (if (seq ambiguous)
              (-> (review-state state ambiguous)
                  (assoc :applied applied :ambiguous-review true :apply-all false))
              (assoc state :step :done :applied applied :apply-all false))}))

(defn accepted-renames
  "Checked renames, with the names the user edited."
  [{:keys [renames checked edits]}]
  (into []
        (comp (filter #(contains? checked (:node-id %)))
              (map (fn [{:keys [node-id] :as rename}]
                     (if-let [edited (get edits node-id)]
                       (assoc rename :new-name (str/trim edited))
                       rename)))
              (remove #(str/blank? (:new-name %))))
        renames))

(defn error-message
  "Translated text of a run error. Daemon errors of this workflow
  start with `auto-name/<code>`."
  [error]
  (let [error (str error)
        code  (second (re-find #"^auto-name/([a-z-]+)" error))]
    (cond
      (= code "no-selection") (tr "penforge.auto-name.error.no-selection")
      (= code "read-failed")  (tr "penforge.auto-name.error.read-failed")
      (= code "apply-failed") (tr "penforge.auto-name.error.apply-failed")
      (= error "busy")        (tr "penforge.auto-name.error.busy")
      (= error "cancelled")   (tr "penforge.auto-name.error.cancelled")
      :else                   (tr "penforge.auto-name.error" error))))

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
         (mf/deps on-change)
         (fn [_]
           (on-change :include-components not)))]

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
  (let [{:keys [renames checked edits result ambiguous-review applied]} state
        all-checked (= (count checked) (count renames))
        remaining   (or (:remaining result) 0)]
    [:div {:class (stl/css :review)}
     (when ambiguous-review
       [:> text* {:as "p" :typography t/body-small :class (stl/css :hint)}
        (tr "penforge.auto-name.review-ambiguous" (i18n/c (or applied 0)))])
     [:div {:class (stl/css :review-header)}
      [:> checkbox* {:id "penforge-auto-name-all"
                     :label (tr "penforge.auto-name.select-all" (i18n/c (count renames)))
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
        (tr "penforge.auto-name.remaining" (i18n/c remaining))])
     (when (:truncated result)
       [:> text* {:as "p" :typography t/body-small :class (stl/css :hint)}
        (tr "penforge.auto-name.truncated")])]))

(mf/defc message-step*
  {::mf/private true}
  [{:keys [state]}]
  (let [{:keys [step error applied result]} state
        skipped (or (:skipped-components result) 0)]
    (cond
      (= step :done)
      [:> context-notification* {:level :success :appearance :ghost}
       (tr "penforge.auto-name.done" (i18n/c (or applied 0)))]

      (= step :empty)
      [:div {:class (stl/css :messages)}
       [:> context-notification* {:level :info :appearance :ghost}
        (tr "penforge.auto-name.none")]
       (when (pos? skipped)
         [:> text* {:as "p" :typography t/body-small :class (stl/css :hint)}
          (tr "penforge.auto-name.skipped-components" (i18n/c skipped))])
       (when (:truncated result)
         [:> text* {:as "p" :typography t/body-small :class (stl/css :hint)}
          (tr "penforge.auto-name.truncated")])]

      :else
      [:> context-notification* {:level :error :appearance :ghost}
       (error-message error)])))

(defn- initial-state
  [scope has-selection]
  {:step :setup
   :options {:scope (if (and (= scope :selection) has-selection) :selection :page)
             :convention :title
             :include-components false}})

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

        ;; one atom per mount; callbacks read it live (see ns doc)
        state*  (mf/with-memo [] (atom (initial-state scope has-selection)))
        state   (mf/deref state*)
        step    (:step state)

        subscription (mf/use-ref nil)

        apply!
        (mf/use-fn
         (mf/deps on-apply)
         (fn [renames]
           (when (seq renames)
             (on-apply renames))))

        handle-message
        (mf/use-fn
         (mf/deps state* apply!)
         (fn [message]
           (let [updated (swap! state* next-state message)]
             (when (and (:apply-all updated) (= :review (:step updated)))
               (let [{to-apply :apply after :state} (apply-all-step updated)]
                 (reset! state* after)
                 (apply! to-apply))))))

        handle-option
        (mf/use-fn
         (mf/deps state*)
         (fn [key value]
           (if (fn? value)
             (swap! state* update-in [:options key] value)
             (swap! state* assoc-in [:options key] value))))

        start
        (mf/use-fn
         (mf/deps state* node-ids page-id handle-message)
         (fn [apply-all]
           (let [rid    (str (random-uuid))
                 params (workflow-params (assoc (:options @state*)
                                                :node-ids node-ids
                                                :page-id page-id))]
             (swap! state* assoc :step :running :apply-all apply-all :progress nil :applied 0)
             ;; subscribe before the request goes out
             (some-> (mf/ref-val subscription) rx/dispose!)
             (mf/set-ref-val! subscription
                              (rx/subs! handle-message
                                        (chat/workflow-messages st/stream rid)))
             (st/emit! (chat/run-workflow "auto-name" params {:rid rid :silent true})))))

        handle-preview
        (mf/use-fn (mf/deps start) #(start false))

        handle-apply-all
        (mf/use-fn (mf/deps start) #(start true))

        handle-toggle
        (mf/use-fn
         (mf/deps state*)
         (fn [node-id]
           (swap! state* update :checked
                  #(if (contains? % node-id) (disj % node-id) (conj % node-id)))))

        handle-toggle-all
        (mf/use-fn
         (mf/deps state*)
         (fn [_]
           (swap! state* (fn [{:keys [renames checked] :as state}]
                           (assoc state :checked
                                  (if (= (count checked) (count renames))
                                    #{}
                                    (into #{} (map :node-id) renames)))))))

        handle-edit
        (mf/use-fn
         (mf/deps state*)
         (fn [node-id value]
           (swap! state* assoc-in [:edits node-id] value)))

        handle-apply
        (mf/use-fn
         (mf/deps state* apply!)
         (fn [_]
           (let [renames (accepted-renames @state*)]
             (apply! renames)
             (swap! state* (fn [state]
                             (assoc state
                                    :step :done
                                    :applied (+ (or (:applied state) 0) (count renames))))))))

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
    (mf/with-effect [state*]
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
           (tr "penforge.auto-name.apply" (i18n/c accepted))]]

         :else
         [:> button* {:variant "primary" :on-click handle-close} (tr "labels.close")])]]]))
