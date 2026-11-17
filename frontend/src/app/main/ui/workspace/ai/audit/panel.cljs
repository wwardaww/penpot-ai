;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.audit.panel
  "Results panel of the design audit (W15): progress, findings grouped
  by severity, \"Fix all with AI\" and \"Run again\". Opened as a modal
  by the `:ai/audit` action."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.uuid :as uuid]
   [app.main.data.ai.actions.audit :as audit]
   [app.main.data.modal :as modal]
   [app.main.data.penforge :as pf]
   [app.main.data.workspace.selection :as dws]
   [app.main.data.workspace.zoom :as dwz]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.controls.switch :refer [switch*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.main.ui.ds.foundations.typography.heading :refer [heading*]]
   [app.main.ui.ds.notifications.context-notification :refer [context-notification*]]
   [app.util.i18n :as i18n :refer [tr]]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ref:audit
  (l/derived #(get-in % [:penforge :audit] {:status :idle}) st/state))

(def ref:persona
  (l/derived pf/current-persona st/state))

(def ref:current-page-id
  (l/derived :current-page-id st/state))

(defn- group-title
  [severity n]
  (case severity
    "error"   (tr "penforge.audit.group.error" n)
    "warning" (tr "penforge.audit.group.warning" n)
    (tr "penforge.audit.group.info" n)))

(defn- severity-icon
  [severity]
  (case severity
    "error"   i/status-wrong
    "warning" i/msg-warning
    i/info))

(defn- error-text
  [{:keys [error error-code]}]
  (cond
    (= error-code "not-connected") (tr "penforge.audit.not-connected")
    (= error "cancelled")          (tr "penforge.audit.stopped")
    :else                          (tr "penforge.audit.error" (or error error-code ""))))

(defn finding-texts
  "Translated `[title message suggestion]` of a finding, from its
  `:code` and `:params`. Findings of the AI review (and codes this
  client does not know) keep the daemon's own texts."
  [{:keys [code params title message suggestion]}]
  (let [{:keys [label ratio background required color width height minimum
                board lines fits component values base replacements canonical
                uses size nearest examples]
         n :count} params]
    (case code
      "contrast"
      [(tr "penforge.audit.contrast.title")
       (tr "penforge.audit.contrast.message" label ratio background required)
       (tr "penforge.audit.contrast.suggestion" color)]

      "contrast-generic"
      [(tr "penforge.audit.contrast.title")
       (tr "penforge.audit.contrast.message" label ratio background required)
       (tr "penforge.audit.contrast.suggestion-generic")]

      "touch-target"
      [(tr "penforge.audit.touch-target.title")
       (tr "penforge.audit.touch-target.message" label width height minimum minimum)
       (tr "penforge.audit.touch-target.suggestion" minimum minimum)]

      "text-cut-off"
      [(tr "penforge.audit.text-cut-off.title")
       (tr "penforge.audit.text-cut-off.message" label board)
       (tr "penforge.audit.text-cut-off.suggestion")]

      "text-may-overflow"
      [(tr "penforge.audit.text-may-overflow.title")
       (tr "penforge.audit.text-may-overflow.message" label lines fits)
       (tr "penforge.audit.text-may-overflow.suggestion")]

      "broken-component"
      [(tr "penforge.audit.broken-component.title")
       (tr "penforge.audit.broken-component.message" label)
       (tr "penforge.audit.broken-component.suggestion")]

      "detached-component"
      [(tr "penforge.audit.detached-component.title")
       (tr "penforge.audit.detached-component.message" label component)
       (tr "penforge.audit.detached-component.suggestion" component)]

      "spacing"
      [(tr "penforge.audit.spacing.title")
       (tr "penforge.audit.spacing.message" label values base)
       (tr "penforge.audit.spacing.suggestion" replacements)]

      "color-duplicate"
      [(tr "penforge.audit.color-duplicate.title")
       (tr "penforge.audit.color-duplicate.message" color label canonical uses)
       (tr "penforge.audit.color-duplicate.suggestion" canonical)]

      "type-scale"
      [(tr "penforge.audit.type-scale.title")
       (tr "penforge.audit.type-scale.message" size label n)
       (tr "penforge.audit.type-scale.suggestion" nearest)]

      "default-name"
      [(tr "penforge.audit.default-name.title")
       (tr "penforge.audit.default-name.message" n examples)
       (tr "penforge.audit.default-name.suggestion")]

      [title message suggestion])))

(mf/defc finding-row*
  {::mf/private true}
  [{:keys [finding developer on-select]}]
  (let [{:keys [code node-id node-name board-name check duplicate]} finding
        [title message suggestion] (finding-texts finding)
        on-click (mf/use-fn
                  (mf/deps on-select node-id)
                  #(on-select node-id))]
    [:li {:class (stl/css :finding)}
     [:button {:class (stl/css :finding-button)
               :title (tr "penforge.audit.show-node")
               :on-click on-click}
      [:span {:class (stl/css :finding-title)}
       title
       (when (= code "ai-review")
         [:span {:class (stl/css :finding-ai)} (tr "penforge.audit.ai-badge")])]
      [:span {:class (stl/css :finding-node)}
       (if (= board-name node-name) node-name (str board-name " › " node-name))]
      [:span {:class (stl/css :finding-message)} message]
      [:span {:class (stl/css :finding-suggestion)} (tr "penforge.audit.suggestion" suggestion)]
      (when duplicate
        [:span {:class (stl/css :finding-badge)} (tr "penforge.audit.already-commented")])
      (when developer
        [:code {:class (stl/css :finding-meta)} (str check " · " node-id)])]]))

(mf/defc audit-content*
  "Body of the panel for an audit state map (pure: no store access)."
  [{:keys [audit persona on-select on-ai-change]}]
  (let [{:keys [status mode progress result fix-result]} audit
        running   (= status :running)
        findings  (:findings result)
        groups    (audit/group-findings findings)
        developer (= persona :developer)]
    [:div {:class (stl/css :content)}
     (when running
       [:div {:class (stl/css :progress) :role "status"}
        (or progress
            (if (= mode :fix)
              (tr "penforge.audit.fixing")
              (tr "penforge.audit.running")))])

     (when (= status :error)
       [:> context-notification* {:level (if (= (:error audit) "cancelled") :info :error)}
        (error-text audit)])

     (when (and fix-result (= mode :fix) (not running))
       [:> context-notification* {:level (if (empty? (:remaining fix-result)) :success :warning)}
        (tr "penforge.audit.fixed"
            (count (:fixed fix-result))
            (+ (count (:fixed fix-result)) (count (:remaining fix-result))))])

     (when result
       [:*
        [:p {:class (stl/css :scope)}
         (tr "penforge.audit.scope" (:node-count result) (count (:boards result)))
         (let [posted (get-in result [:comments :posted] 0)]
           (when (pos? posted)
             [:span " " (tr "penforge.audit.comments-added" posted)]))]

        (when (:truncated result)
          [:> context-notification* {:level :warning}
           (tr "penforge.audit.truncated")])

        (let [unchecked (:contrast-unchecked result 0)]
          (when (pos? unchecked)
            [:p {:class (stl/css :scope)}
             (tr "penforge.audit.contrast-unchecked" unchecked)]))

        (if (empty? findings)
          [:p {:class (stl/css :empty)} (tr "penforge.audit.no-findings")]
          (for [[severity group] groups]
            [:section {:key severity :class (stl/css :group)}
             [:h3 {:class (stl/css :group-title)}
              [:> icon* {:icon-id (severity-icon severity)
                         :size "s"
                         :class (stl/css-case :group-icon true
                                              :error (= severity "error")
                                              :warning (= severity "warning"))}]
              (group-title severity (count group))]
             [:ul {:class (stl/css :findings)}
              (for [finding group]
                [:> finding-row* {:key (:id finding)
                                  :finding finding
                                  :developer developer
                                  :on-select on-select}])]]))

        (when (and developer (get-in result [:report :path]))
          [:p {:class (stl/css :report)}
           (tr "penforge.audit.report" (get-in result [:report :path]))])])

     [:div {:class (stl/css :options)}
      [:> switch* {:label (tr "penforge.audit.ai-review")
                   :default-checked (boolean (get-in audit [:params :ai]))
                   :disabled running
                   :on-change on-ai-change}]]]))

(mf/defc audit-panel*
  {::mf/register modal/components
   ::mf/register-as :penforge-audit}
  []
  (let [audit           (mf/deref ref:audit)
        persona         (mf/deref ref:persona)
        current-page-id (mf/deref ref:current-page-id)
        ai*             (mf/use-state (boolean (get-in audit [:params :ai])))
        running         (audit/running? audit)
        result          (:result audit)
        thread-ids      (audit/fixable-thread-ids result)

        on-close
        (mf/use-fn #(st/emit! (modal/hide)))

        on-select
        (mf/use-fn
         (mf/deps result current-page-id)
         (fn [node-id]
           ;; only nodes of the open page can be shown
           (when (= (:page-id result) (str current-page-id))
             (let [id (uuid/parse node-id)]
               (st/emit! (modal/hide)
                         (dws/select-shape id)
                         (dwz/fit-to-shapes #{id}))))))

        on-ai-change
        (mf/use-fn #(reset! ai* %))

        on-run
        (mf/use-fn
         (mf/deps ai*)
         #(st/emit! (audit/rerun-audit @ai*)))

        on-fix
        (mf/use-fn #(st/emit! (audit/fix-all)))

        on-stop
        (mf/use-fn #(st/emit! (audit/cancel)))]

    [:div {:class (stl/css :modal-overlay)}
     [:div {:class (stl/css :modal-container)
            :role "dialog"
            :aria-labelledby "penforge-audit-title"
            :data-testid "ai-audit-panel"}
      [:div {:class (stl/css :modal-header)}
       [:> heading* {:level 2
                     :id "penforge-audit-title"
                     :typography "headline-medium"}
        (tr "penforge.audit.title")]
       [:> icon-button* {:variant "ghost"
                         :aria-label (tr "labels.close")
                         :on-click on-close
                         :icon i/close}]]

      [:> audit-content* {:audit audit
                          :persona persona
                          :on-select on-select
                          :on-ai-change on-ai-change}]

      [:div {:class (stl/css :modal-footer)}
       (if running
         [:> button* {:variant "secondary" :on-click on-stop}
          (tr "penforge.audit.stop")]
         [:> button* {:variant "secondary" :on-click on-run}
          (tr "penforge.audit.run-again")])
       [:> button* {:variant "primary"
                    :disabled (or running (empty? thread-ids))
                    :on-click on-fix}
        (tr "penforge.audit.fix-all")]]]]))
