;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.design-md.panel
  "Design system panel (W22): view and edit the project's DESIGN.md,
  apply it to the open file, update it from the file, let the AI draft
  it, and browse or restore its saved versions (the project's local
  `design/` git repository). Opens as the `:penforge-design-md` modal."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.time :as ct]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.modal :as modal]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :refer [icon*] :as i]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.heading :refer [heading*]]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.main.ui.workspace.ai.chat.markdown :refer [markdown*]]
   [app.main.ui.workspace.ai.design-md.state :as dms]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private ref:connected
  (l/derived #(= :connected (get-in % [:penforge :connection :status])) st/state))

(defn- format-date
  [date]
  (try
    (ct/format-inst (ct/inst date) "PPp")
    (catch :default _ (str date))))

(defn- run-workflow!
  "Start workflow `name` and fold its messages into the panel state.
  After a run that changed DESIGN.md, the file and its history are read
  again."
  [state* subscription name params]
  (let [rid (proto/next-rid)]
    (some-> (mf/ref-val subscription) rx/dispose!)
    (swap! state* dms/start-op name rid)
    (mf/set-ref-val!
     subscription
     (->> (chat/workflow-messages st/stream rid)
          (rx/subs!
           (fn [message]
             (swap! state* dms/apply-message name message)
             (when (and (= "workflow.done" (:type message))
                        (:ok message)
                        (contains? dms/mutating-workflows name))
               (run-workflow! state* subscription dms/read-workflow {}))))))
    (st/emit! (chat/run-workflow name params {:rid rid :silent true}))))

;; --- Parts

(mf/defc preview*
  {::mf/private true}
  [{:keys [content]}]
  (let [{:keys [front-matter body]} (mf/with-memo [content]
                                      (dms/split-front-matter content))]
    [:div {:class (stl/css :preview)}
     (when (seq front-matter)
       [:details {:class (stl/css :front-matter)}
        [:summary {:class (stl/css :front-matter-title)}
         (tr "penforge.design-md.front-matter")]
        [:pre {:class (stl/css :code)} front-matter]])
     [:> markdown* {:text body}]]))

(mf/defc issues*
  {::mf/private true}
  [{:keys [issues]}]
  (when (seq issues)
    [:section {:class (stl/css :side-section)}
     [:> heading* {:level 3 :typography t/headline-small :class (stl/css :side-title)}
      (tr "penforge.design-md.issues.title")]
     [:ul {:class (stl/css :issues)}
      (for [[index {:keys [severity path message]}] (map-indexed vector issues)]
        [:li {:key index
              :class (stl/css-case :issue true
                                   :issue-error (= severity "error"))}
         [:> icon* {:icon-id (if (= severity "error") i/msg-error i/msg-warning)
                    :size "s"}]
         [:span [:code path] " " message]])]]))

(mf/defc history*
  {::mf/private true}
  [{:keys [history viewing disabled on-view on-current]}]
  [:section {:class (stl/css :side-section)}
   [:> heading* {:level 3 :typography t/headline-small :class (stl/css :side-title)}
    (tr "penforge.design-md.history.title")]
   (if (empty? history)
     [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
      (tr "penforge.design-md.history.empty")]
     [:ol {:class (stl/css :history)}
      (for [[index {:keys [commit date subject]}] (map-indexed vector history)]
        (let [current?  (and (zero? index) (nil? viewing))
              selected? (or current? (= commit (:ref viewing)))]
          [:li {:key commit}
           [:button {:type "button"
                     :class (stl/css-case :history-item true
                                          :history-selected selected?)
                     :disabled disabled
                     :on-click #(if (zero? index) (on-current) (on-view commit))}
            [:span {:class (stl/css :history-subject)} subject]
            [:span {:class (stl/css :history-date)}
             (if (zero? index)
               (tr "penforge.design-md.history.current")
               (format-date date))
             " · " (dms/short-commit commit)]]]))])])

(mf/defc draft*
  {::mf/private true}
  [{:keys [prompt disabled on-change on-submit]}]
  [:section {:class (stl/css :side-section)}
   [:label {:class (stl/css :side-title) :for "design-md-draft"}
    (tr "penforge.design-md.draft.label")]
   [:textarea {:id "design-md-draft"
               :class (stl/css :input :draft-input)
               :rows 3
               :value prompt
               :disabled disabled
               :placeholder (tr "penforge.design-md.draft.placeholder")
               :on-change on-change}]
   [:> button* {:variant "secondary"
                :type "button"
                :disabled (or disabled (empty? (.trim prompt)))
                :on-click on-submit}
    (tr "penforge.design-md.draft.submit")]])

(mf/defc report*
  {::mf/private true}
  [{:keys [report]}]
  (let [{:keys [colors typographies tokens components checkpoint warnings]} report
        [colors-added colors-updated] (dms/report-counts colors)
        [typos-added typos-updated] (dms/report-counts typographies)
        [tokens-added tokens-updated] (dms/report-counts tokens)]
    [:div {:class (stl/css :report) :role "status"}
     (when checkpoint
       [:> text* {:as "p" :typography t/body-small}
        (tr "penforge.design-md.report.checkpoint")])
     [:> text* {:as "p" :typography t/body-small}
      (tr "penforge.design-md.report.colors" colors-added colors-updated)]
     [:> text* {:as "p" :typography t/body-small}
      (tr "penforge.design-md.report.typographies" typos-added typos-updated)]
     [:> text* {:as "p" :typography t/body-small}
      (tr "penforge.design-md.report.tokens" tokens-added tokens-updated)]
     (when components
       [:> text* {:as "p" :typography t/body-small}
        (tr "penforge.design-md.report.components" (count (:tagged components)))])
     (when (seq (:missing components))
       [:> text* {:as "p" :typography t/body-small}
        (tr "penforge.design-md.report.missing" (apply str (interpose ", " (:missing components))))])
     (for [[index warning] (map-indexed vector warnings)]
       [:> text* {:key index :as "p" :typography t/body-small :class (stl/css :muted)}
        warning])]))

(mf/defc question*
  {::mf/private true}
  [{:keys [run-id question on-answered]}]
  (let [{:keys [question-id text options]} question]
    [:div {:class (stl/css :question) :role "alert"}
     [:> text* {:as "p" :typography t/body-medium} text]
     [:div {:class (stl/css :actions)}
      (for [{:keys [id label]} options]
        [:> button* {:key id
                     :variant "secondary"
                     :type "button"
                     :on-click (fn []
                                 (st/emit! (chat/answer-question run-id question-id id))
                                 (on-answered))}
         label])]]))

(mf/defc status-line*
  {::mf/private true}
  [{:keys [state]}]
  (let [{:keys [op error notice]} state]
    (cond
      (some? op)
      [:div {:class (stl/css :status) :aria-live "polite"}
       [:span {:class (stl/css :spinner) :aria-hidden true}]
       [:> text* {:as "span" :typography t/body-small}
        (or (:progress op) (tr "penforge.design-md.working"))]]

      (some? error)
      [:div {:class (stl/css :status :status-error) :role "alert"}
       [:> icon* {:icon-id i/msg-error :size "s"}]
       [:> text* {:as "span" :typography t/body-small}
        (tr "penforge.design-md.error" error)]]

      (some? notice)
      [:div {:class (stl/css :status) :role "status"}
       [:> icon* {:icon-id i/status-tick :size "s"}]
       [:> text* {:as "span" :typography t/body-small} notice]]

      :else
      nil)))

;; --- Panel

(mf/defc design-md-view*
  "The panel for a given state; every change goes through the handlers."
  [{:keys [state connected on-close on-mode on-content on-prompt on-save on-discard
           on-apply on-export on-draft on-view on-current on-restore on-answered]}]
  (let [{:keys [loaded exists content history issues viewing mode op prompt report]} state
        busy      (dms/busy? state)
        dirty     (dms/dirty? state)
        disabled  (or busy (not connected))
        errors    (dms/error-count issues)
        shown     (if viewing (:content viewing) content)
        editing   (and (= mode :edit) (nil? viewing))]

    [:div {:class (stl/css :overlay)}
     [:div {:class (stl/css :dialog)
            :role "dialog"
            :aria-modal true
            :aria-labelledby "design-md-title"
            :data-testid "design-md-panel"}
      [:header {:class (stl/css :header)}
       [:> icon* {:icon-id i/tokens :size "m"}]
       [:div {:class (stl/css :header-text)}
        [:> heading* {:id "design-md-title"
                      :level 2
                      :typography t/title-medium
                      :class (stl/css :title)}
         (tr "penforge.design-md.title")]
        [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
         (tr "penforge.design-md.subtitle")]]
       [:> icon-button* {:variant "ghost"
                         :icon i/close
                         :aria-label (tr "penforge.design-md.close")
                         :on-click on-close}]]

      (cond
        (not connected)
        [:div {:class (stl/css :empty)}
         [:> text* {:as "p" :typography t/body-medium}
          (tr "penforge.design-md.not-connected")]]

        (not loaded)
        [:div {:class (stl/css :empty)}
         [:span {:class (stl/css :spinner) :aria-hidden true}]
         [:> text* {:as "p" :typography t/body-medium}
          (tr "penforge.design-md.loading")]]

        :else
        [:div {:class (stl/css :body)}
         [:main {:class (stl/css :main)}
          (when viewing
            [:div {:class (stl/css :viewing)}
             [:> text* {:as "p" :typography t/body-small}
              (tr "penforge.design-md.viewing" (dms/short-commit (:ref viewing)))]
             [:div {:class (stl/css :actions)}
              [:> button* {:variant "secondary" :type "button" :disabled disabled :on-click on-restore}
               (tr "penforge.design-md.restore")]
              [:> button* {:variant "ghost" :type "button" :disabled busy :on-click on-current}
               (tr "penforge.design-md.back")]]])

          (if (and (not exists) (not dirty) (nil? viewing) (not editing))
            [:div {:class (stl/css :empty)}
             [:> heading* {:level 3 :typography t/headline-medium}
              (tr "penforge.design-md.empty.title")]
             [:> text* {:as "p" :typography t/body-medium :class (stl/css :muted)}
              (tr "penforge.design-md.empty.hint")]
             [:div {:class (stl/css :actions)}
              [:> button* {:variant "primary" :type "button" :disabled disabled :on-click on-export}
               (tr "penforge.design-md.create-from-file")]
              [:> button* {:variant "secondary" :type "button" :disabled disabled
                           :on-click #(on-mode :edit)}
               (tr "penforge.design-md.write")]]]

            [:*
             [:div {:class (stl/css :toolbar)}
              [:div {:class (stl/css :tabs) :role "tablist"}
               [:button {:type "button"
                         :role "tab"
                         :aria-selected (not editing)
                         :class (stl/css-case :tab true :tab-selected (not editing))
                         :on-click #(on-mode :preview)}
                (tr "penforge.design-md.preview")]
               [:button {:type "button"
                         :role "tab"
                         :aria-selected editing
                         :class (stl/css-case :tab true :tab-selected editing)
                         :disabled (some? viewing)
                         :on-click #(on-mode :edit)}
                (tr "penforge.design-md.edit")]]
              [:div {:class (stl/css :actions)}
               [:> button* {:variant "secondary" :type "button" :disabled disabled :on-click on-export}
                (tr "penforge.design-md.update-from-file")]
               [:> button* {:variant "primary" :type "button"
                            :disabled (or disabled (some? viewing) (pos? errors) (empty? content))
                            :title (when (pos? errors) (tr "penforge.design-md.issues.errors" errors))
                            :on-click on-apply}
                (tr "penforge.design-md.apply")]]]

             (if editing
               [:textarea {:class (stl/css :input :editor)
                           :value content
                           :disabled busy
                           :spell-check false
                           :aria-label (tr "penforge.design-md.edit")
                           :on-change on-content}]
               [:> preview* {:content shown}])])]

         [:aside {:class (stl/css :side)}
          [:> issues* {:issues (if viewing (:issues viewing) issues)}]
          [:> history* {:history history
                        :viewing viewing
                        :disabled busy
                        :on-view on-view
                        :on-current on-current}]
          [:> draft* {:prompt prompt
                      :disabled disabled
                      :on-change on-prompt
                      :on-submit on-draft}]]])

      (when-let [question (:question op)]
        [:> question* {:run-id (:run-id op)
                       :question question
                       :on-answered on-answered}])

      (when report
        [:> report* {:report report}])

      [:footer {:class (stl/css :footer)}
       [:> status-line* {:state state}]
       [:div {:class (stl/css :actions)}
        (when dirty
          [:> text* {:as "span" :typography t/body-small :class (stl/css :muted)}
           (tr "penforge.design-md.unsaved")])
        [:> button* {:variant "ghost" :type "button" :disabled (or busy (not dirty)) :on-click on-discard}
         (tr "penforge.design-md.discard")]
        [:> button* {:variant "primary" :type "button" :disabled (or disabled (not dirty)) :on-click on-save}
         (tr "penforge.design-md.save")]]]]]))

#_{:clojure-lsp/ignore [:clojure-lsp/unused-public-var]}
(mf/defc design-md-modal*
  "DESIGN.md panel as a modal; owns the panel state and the workflow runs."
  {::mf/register modal/components
   ::mf/register-as :penforge-design-md}
  []
  (let [state*       (mf/use-state dms/initial-state)
        state        (deref state*)
        connected    (mf/deref ref:connected)
        subscription (mf/use-ref nil)

        run          (mf/use-fn
                      (fn [name params]
                        (run-workflow! state* subscription name params)))

        on-close     (mf/use-fn #(st/emit! (modal/hide)))
        on-mode      (mf/use-fn #(swap! state* assoc :mode %))
        on-content   (mf/use-fn #(swap! state* assoc :content (dom/get-target-val %)))
        on-prompt    (mf/use-fn #(swap! state* assoc :prompt (dom/get-target-val %)))
        on-discard   (mf/use-fn #(swap! state* (fn [s] (assoc s :content (:saved s)))))
        on-answered  (mf/use-fn #(swap! state* dms/clear-question))

        on-save
        (mf/use-fn
         (mf/deps run state)
         #(run dms/save-workflow {:content (:content state)}))

        on-apply
        (mf/use-fn
         (mf/deps run state)
         #(run dms/import-workflow {:content (:content state)}))

        on-export
        (mf/use-fn (mf/deps run) #(run dms/export-workflow {}))

        on-draft
        (mf/use-fn
         (mf/deps run state)
         (fn []
           (run dms/draft-workflow {:prompt (:prompt state)})
           (swap! state* assoc :prompt "")))

        on-view
        (mf/use-fn (mf/deps run) #(run dms/read-workflow {:ref %}))

        on-current
        (mf/use-fn (mf/deps run) #(run dms/read-workflow {}))

        on-restore
        (mf/use-fn
         (mf/deps run state)
         (fn []
           (when-let [{:keys [ref content]} (:viewing state)]
             (run dms/save-workflow {:content content
                                     :message (str "restore version " (dms/short-commit ref))}))))]

    (mf/with-effect [connected]
      (when connected
        (run dms/read-workflow {})))

    (mf/with-effect []
      #(some-> (mf/ref-val subscription) rx/dispose!))

    [:> design-md-view* {:state state
                         :connected connected
                         :on-close on-close
                         :on-mode on-mode
                         :on-content on-content
                         :on-prompt on-prompt
                         :on-save on-save
                         :on-discard on-discard
                         :on-apply on-apply
                         :on-export on-export
                         :on-draft on-draft
                         :on-view on-view
                         :on-current on-current
                         :on-restore on-restore
                         :on-answered on-answered}]))
