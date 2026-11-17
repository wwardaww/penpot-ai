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

(mf/defc finding-row*
  {::mf/private true}
  [{:keys [finding developer on-select]}]
  (let [{:keys [title message suggestion node-id node-name board-name check duplicate]} finding
        on-click (mf/use-fn
                  (mf/deps on-select node-id)
                  #(on-select node-id))]
    [:li {:class (stl/css :finding)}
     [:button {:class (stl/css :finding-button)
               :title (tr "penforge.audit.show-node")
               :on-click on-click}
      [:span {:class (stl/css :finding-title)} title]
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
