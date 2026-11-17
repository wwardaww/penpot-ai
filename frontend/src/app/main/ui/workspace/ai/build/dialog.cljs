;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.build.dialog
  "The Build dialog (W08): plan card, confirmation (with the editable
  plan for developers), progress list, done and error states.

  Designers see outcomes only; commands, routes, logs and error output
  are shown to developers."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.client :as client]
   [app.main.data.modal :as modal]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.controls.input :refer [input*]]
   [app.main.ui.ds.foundations.assets.icon :refer [icon*] :as i]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.main.ui.workspace.ai.build.events :as build]
   [app.main.ui.workspace.ai.chat.markdown :refer [markdown*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [cuerdas.core :as str]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private ref:build
  (l/derived build/get-build st/state))

(def ^:private ref:persona
  (l/derived client/get-persona st/state))

;; --- Pieces

(mf/defc step-icon*
  {::mf/private true}
  [{:keys [status]}]
  (cond
    (= status :done)
    [:> icon* {:icon-id i/tick :size "s" :class (stl/css :step-done)}]

    (= status :error)
    [:> icon* {:icon-id i/status-wrong :size "s" :class (stl/css :step-error)}]

    :else
    [:span {:class (stl/css :spinner) :aria-hidden true}]))

(defn get-step-label
  "Translated label of a progress step; developers also get the
  technical detail (command, stack, workflow, attempt)."
  [{:keys [step name update detail label]} persona]
  (let [text (case step
               "read" (tr "penforge.build.step.read")
               "plan" (tr "penforge.build.step.plan")
               "prepare" (tr "penforge.build.step.prepare")
               "prebuild" (tr "penforge.build.step.prebuild")
               "scaffold" (tr "penforge.build.step.scaffold")
               "screen" (if update
                          (tr "penforge.build.step.screen-update" name)
                          (tr "penforge.build.step.screen" name))
               "cleanup" (tr "penforge.build.step.cleanup")
               "install" (tr "penforge.build.step.install")
               "check" (tr "penforge.build.step.check")
               "fix" (tr "penforge.build.step.fix")
               "save" (tr "penforge.build.step.save")
               label)]
    (if (and (= persona :developer) (seq detail))
      (str text " · " detail)
      text)))

(mf/defc steps*
  {::mf/private true}
  [{:keys [steps activity persona]}]
  [:div {:class (stl/css :steps-wrapper)}
   (when (seq steps)
     [:ol {:class (stl/css :steps) :aria-live "polite"}
      (for [{:keys [id status] :as step} steps]
        [:li {:key id :class (stl/css :step)}
         [:> step-icon* {:status status}]
         [:span {:class (stl/css :step-label)} (get-step-label step persona)]])])
   (when (seq activity)
     [:> text* {:as "p" :typography t/body-small :class (stl/css :muted :activity)}
      activity])])

(defn- screen-status-label
  [status]
  (case status
    "new" (tr "penforge.build.status.new")
    "changed" (tr "penforge.build.status.changed")
    "removed" (tr "penforge.build.status.removed")
    (tr "penforge.build.status.same")))

(mf/defc screens*
  {::mf/private true}
  [{:keys [screens]}]
  [:section {:class (stl/css :section)}
   [:> text* {:as "h3" :typography t/headline-small :class (stl/css :section-title)}
    (tr "penforge.build.plan.screens")]
   [:ul {:class (stl/css :screens)}
    (for [{:keys [board-id name status]} screens]
      [:li {:key board-id :class (stl/css :screen)}
       [:span {:class (stl/css :screen-name)} name]
       [:span {:class (stl/css-case :badge true
                                    :badge-new (= status "new")
                                    :badge-changed (= status "changed")
                                    :badge-removed (= status "removed"))}
        (screen-status-label status)]])]])

(mf/defc logs*
  {::mf/private true}
  [{:keys [logs]}]
  (when (seq logs)
    [:details {:class (stl/css :details)}
     [:summary (tr "penforge.build.dev.logs")]
     [:pre {:class (stl/css :pre)} (str/join "\n\n" logs)]]))

;; --- Plan

(mf/defc route-input*
  {::mf/private true}
  [{:keys [board-id name value on-change]}]
  (let [on-change
        (mf/use-fn
         (mf/deps board-id on-change)
         #(on-change board-id (dom/get-target-val %)))]
    [:> input* {:label name
                :value value
                :on-change on-change}]))

(mf/defc developer-plan*
  {::mf/private true}
  [{:keys [developer stack-name routes notes on-stack-name on-route on-notes]}]
  (let [{:keys [stack components tree]} developer
        commands (:commands stack)]
    [:*
     [:section {:class (stl/css :section)}
      [:> text* {:as "h3" :typography t/headline-small :class (stl/css :section-title)}
       (tr "penforge.build.dev.stack")]
      [:> input* {:label (tr "penforge.build.dev.stack")
                  :value stack-name
                  :on-change on-stack-name}]
      (when (seq commands)
        [:pre {:class (stl/css :pre)}
         (->> [:install :build :typecheck :dev]
              (keep (fn [k]
                      (when-let [argv (get commands k)]
                        (str (name k) ": " (str/join " " argv)))))
              (str/join "\n"))])]

     [:section {:class (stl/css :section)}
      [:> text* {:as "h3" :typography t/headline-small :class (stl/css :section-title)}
       (tr "penforge.build.dev.routes")]
      [:div {:class (stl/css :routes)}
       (for [{:keys [board-id name]} (:routes developer)]
         [:> route-input* {:key board-id
                           :board-id board-id
                           :name name
                           :value (get routes board-id "")
                           :on-change on-route}])]]

     (when (seq components)
       [:section {:class (stl/css :section)}
        [:> text* {:as "h3" :typography t/headline-small :class (stl/css :section-title)}
         (tr "penforge.build.dev.components")]
        [:ul {:class (stl/css :components)}
         (for [{:keys [name purpose]} components]
           [:li {:key name}
            [:strong name]
            (when (seq purpose) (str " — " purpose))])]])

     (when (seq tree)
       [:details {:class (stl/css :details)}
        [:summary (tr "penforge.build.dev.tree")]
        [:pre {:class (stl/css :pre)} tree]])

     [:section {:class (stl/css :section)}
      [:label {:class (stl/css :notes-label)}
       [:> text* {:as "span" :typography t/body-small} (tr "penforge.build.dev.notes")]
       [:textarea {:class (stl/css :notes)
                   :rows 3
                   :value notes
                   :placeholder (tr "penforge.build.dev.notes-placeholder")
                   :on-change on-notes}]]]]))

(defn- initial-routes
  [developer]
  (into {} (map (juxt :board-id :route)) (:routes developer)))

(defn get-overrides
  "The developer's edits of a plan, as `build-run` overrides; nil when
  nothing changed."
  [developer {:keys [stack-name routes notes]}]
  (let [original (initial-routes developer)
        changed  (into {}
                       (filter (fn [[board-id route]]
                                 (not= route (get original board-id))))
                       routes)
        stack    (some-> stack-name str/trim)]
    (not-empty
     (d/without-nils
      {:notes (some-> notes str/trim not-empty)
       :stack-name (when (and (seq stack) (not= stack (get-in developer [:stack :name])))
                     stack)
       :routes (not-empty changed)}))))

(mf/defc plan-view*
  {::mf/private true}
  [{:keys [plan persona]}]
  (let [{:keys [summary mode screens developer]} plan
        developer?   (and (= persona :developer) (some? developer))
        nothing?     (= "none" mode)

        stack-name*  (mf/use-state #(get-in developer [:stack :name] ""))
        routes*      (mf/use-state #(initial-routes developer))
        notes*       (mf/use-state "")

        on-stack-name
        (mf/use-fn #(reset! stack-name* (dom/get-target-val %)))

        on-route
        (mf/use-fn (fn [board-id value] (swap! routes* assoc board-id value)))

        on-notes
        (mf/use-fn #(reset! notes* (dom/get-target-val %)))

        on-confirm
        (mf/use-fn
         (mf/deps developer? developer)
         (fn []
           (st/emit! (build/confirm
                      (when developer?
                        (get-overrides developer {:stack-name @stack-name*
                                                  :routes @routes*
                                                  :notes @notes*}))))))

        on-cancel
        (mf/use-fn #(st/emit! (build/cancel)))]

    [:*
     [:div {:class (stl/css :body)}
      [:div {:class (stl/css :summary)}
       ;; Claude writes the summary of a full plan; the other modes are
       ;; worded here so they get translated.
       (cond
         nothing? [:> text* {:as "p" :typography t/body-medium}
                   (tr "penforge.build.plan.summary-none")]
         (= "incremental" mode) [:> text* {:as "p" :typography t/body-medium}
                                 (tr "penforge.build.plan.summary-incremental")]
         :else [:> markdown* {:text (or summary "")}])]
      (when (seq screens)
        [:> screens* {:screens screens}])
      (when (and developer? (not nothing?))
        [:> developer-plan* {:developer developer
                             :stack-name @stack-name*
                             :routes @routes*
                             :notes @notes*
                             :on-stack-name on-stack-name
                             :on-route on-route
                             :on-notes on-notes}])
      [:> text* {:as "p" :typography t/body-medium :class (stl/css :question)}
       (cond
         nothing? (tr "penforge.build.plan.nothing-question")
         developer? (tr "penforge.build.plan.question-developer")
         :else (tr "penforge.build.plan.question"))]]
     [:footer {:class (stl/css :footer)}
      [:> button* {:variant "secondary" :on-click on-cancel}
       (tr "penforge.build.plan.not-now")]
      [:> button* {:variant "primary" :on-click on-confirm}
       (if nothing?
         (tr "penforge.build.plan.rebuild")
         (tr "penforge.build.plan.confirm"))]]]))

;; --- Other stages

(mf/defc planning-view*
  {::mf/private true}
  [{:keys [build persona]}]
  (let [on-cancel (mf/use-fn #(st/emit! (build/cancel)))]
    [:*
     [:div {:class (stl/css :body)}
      [:> text* {:as "p" :typography t/body-medium}
       (tr "penforge.build.planning")]
      [:> steps* {:steps (:steps build) :activity (:activity build) :persona persona}]]
     [:footer {:class (stl/css :footer)}
      [:> button* {:variant "secondary" :on-click on-cancel}
       (tr "penforge.build.stop")]]]))

(mf/defc building-view*
  {::mf/private true}
  [{:keys [build persona]}]
  (let [on-hide (mf/use-fn #(st/emit! (build/close)))
        on-stop (mf/use-fn #(st/emit! (build/cancel)))]
    [:*
     [:div {:class (stl/css :body)}
      [:> text* {:as "p" :typography t/body-medium}
       (tr "penforge.build.building")]
      [:> steps* {:steps (:steps build) :activity (:activity build) :persona persona}]
      (when (= persona :developer)
        [:> logs* {:logs (:logs build)}])]
     [:footer {:class (stl/css :footer)}
      [:> button* {:variant "secondary" :on-click on-stop}
       (tr "penforge.build.stop")]
      [:> button* {:variant "primary" :on-click on-hide}
       (tr "penforge.build.hide")]]]))

(mf/defc done-view*
  {::mf/private true}
  [{:keys [build persona]}]
  (let [{:keys [result logs]} build
        commit   (:commit result)
        on-close (mf/use-fn #(st/emit! (build/close)))
        on-open  (mf/use-fn #(st/emit! (build/open-preview)))]
    [:*
     [:div {:class (stl/css :body :done)}
      [:> icon* {:icon-id i/tick :size "l" :class (stl/css :step-done)}]
      [:> text* {:as "p" :typography t/headline-small}
       (tr "penforge.build.done.title")]
      (when (= persona :developer)
        [:*
         (when (string? commit)
           [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
            (tr "penforge.build.dev.commit" (subs commit 0 (min 10 (count commit))))])
         [:> logs* {:logs logs}]])]
     [:footer {:class (stl/css :footer)}
      [:> button* {:variant "secondary" :on-click on-close}
       (tr "penforge.build.close")]
      [:> button* {:variant "primary" :on-click on-open}
       (tr "penforge.build.done.open-preview")]]]))

(defn- get-error-message
  [{:keys [failure-code error]}]
  (cond
    (= failure-code "no-boards") (tr "penforge.build.failed.no-boards")
    (= failure-code "plan-failed") (tr "penforge.build.failed.plan-failed")
    (= failure-code "stale-plan") (tr "penforge.build.failed.stale-plan")
    (= failure-code "busy") (tr "penforge.build.failed.busy")
    (= failure-code "gave-up") (tr "penforge.build.failed.gave-up")
    (= error "not-connected") (tr "penforge.build.error.not-connected")
    :else (tr "penforge.build.error.generic")))

(mf/defc error-view*
  {::mf/private true}
  [{:keys [build persona]}]
  (let [{:keys [error failure logs]} build
        not-connected? (= error "not-connected")
        on-close   (mf/use-fn #(st/emit! (build/cancel)))
        on-retry   (mf/use-fn #(st/emit! (build/retry)))
        on-open-ai (mf/use-fn #(st/emit! (modal/hide) (chat/open-chat)))]
    [:*
     [:div {:class (stl/css :body)}
      [:div {:class (stl/css :error-line) :role "alert"}
       [:> icon* {:icon-id i/msg-error :size "s" :class (stl/css :step-error)}]
       [:> text* {:as "p" :typography t/body-medium}
        (get-error-message build)]]
      (when (and (= persona :developer) (or (seq failure) (seq error)) (not not-connected?))
        [:details {:class (stl/css :details) :open true}
         [:summary (tr "penforge.build.dev.details")]
         [:pre {:class (stl/css :pre)} (or (not-empty failure) error)]])
      (when (= persona :developer)
        [:> logs* {:logs logs}])]
     [:footer {:class (stl/css :footer)}
      [:> button* {:variant "secondary" :on-click on-close}
       (tr "penforge.build.close")]
      (if not-connected?
        [:> button* {:variant "primary" :on-click on-open-ai}
         (tr "penforge.build.error.open-ai")]
        [:> button* {:variant "primary" :on-click on-retry}
         (tr "penforge.build.error.retry")])]]))

;; --- Dialog

(mf/defc build-view*
  "Content of the build dialog for a build state and a persona."
  [{:keys [build persona]}]
  (let [stage (:stage build)]
    (cond
      (= stage :planning) [:> planning-view* {:build build :persona persona}]
      (= stage :plan) [:> plan-view* {:key (get-in build [:plan :plan-id])
                                      :plan (:plan build)
                                      :persona persona}]
      (= stage :building) [:> building-view* {:build build :persona persona}]
      (= stage :done) [:> done-view* {:build build :persona persona}]
      (= stage :error) [:> error-view* {:build build :persona persona}]
      :else nil)))

(mf/defc build-dialog
  {::mf/register modal/components
   ::mf/register-as build/modal-type}
  []
  (let [build    (mf/deref ref:build)
        persona  (mf/deref ref:persona)
        on-close (mf/use-fn #(st/emit! (build/close)))]
    [:div {:class (stl/css :modal-overlay)}
     [:div {:class (stl/css :modal-dialog)
            :role "dialog"
            :aria-labelledby "penforge-build-title"
            :data-testid "penforge-build-dialog"}
      [:header {:class (stl/css :header)}
       [:> text* {:as "h2" :id "penforge-build-title"
                  :typography t/headline-medium :class (stl/css :title)}
        (tr "penforge.build.title")]
       [:> icon-button* {:variant "ghost"
                         :icon i/close
                         :aria-label (tr "penforge.build.close")
                         :on-click on-close}]]
      [:> build-view* {:build build :persona persona}]]]))
