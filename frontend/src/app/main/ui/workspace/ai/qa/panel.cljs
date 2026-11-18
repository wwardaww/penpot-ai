;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.qa.panel
  "Report of the visual QA (W18): per screen, the design next to the
  running app and the difference map, the match score, and \"Fix the
  differences\" / \"Keep fixing\" / \"Accept as is\". Opened as a modal
  by the `:ai/visual-qa` action and after an automatic check."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.modal :as modal]
   [app.main.data.penforge :as pf]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.controls.switch :refer [switch*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography.heading :refer [heading*]]
   [app.main.ui.ds.notifications.context-notification :refer [context-notification*]]
   [app.main.ui.workspace.ai.qa.events :as qa]
   [app.util.i18n :refer [tr]]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ref:qa
  (l/derived qa/get-qa st/state))

(def ref:persona
  (l/derived pf/current-persona st/state))

(defn progress-text
  "Translated text of a `progress` payload (`:step` + `:params`); the
  daemon's English `:text` for unknown steps."
  [{:keys [step params text]}]
  (let [{:keys [name attempt of]} params]
    (case step
      "preview"    (tr "penforge.qa.step.preview")
      "browser"    (tr "penforge.qa.step.browser")
      "design"     (tr "penforge.qa.step.design" name)
      "app"        (tr "penforge.qa.step.app" name)
      "compare"    (tr "penforge.qa.step.compare" name)
      "checkpoint" (tr "penforge.qa.step.checkpoint")
      "fix"        (tr "penforge.qa.step.fix" name attempt of)
      "save"       (tr "penforge.qa.step.save")
      text)))

(defn error-text
  "Translated explanation of a failed run."
  [{:keys [error error-code]} developer]
  (cond
    (= error "cancelled")                 (tr "penforge.qa.error.stopped")
    (= error-code "not-connected")        (tr "penforge.qa.error.not-connected")
    (= error-code "not-built")            (tr "penforge.qa.error.not-built")
    (= error-code "other-file")           (tr "penforge.qa.error.other-file")
    (= error-code "no-screens")           (tr "penforge.qa.error.no-screens")
    (= error-code "busy")                 (tr "penforge.qa.error.busy")
    (= error-code "no-preview")           (tr "penforge.qa.error.no-preview")
    (= error-code "no-browser")           (tr "penforge.qa.error.no-browser")
    (= error-code "design-unavailable")   (tr "penforge.qa.error.design-unavailable")
    (and developer (some? error))         (tr "penforge.qa.error.generic-detail" error)
    :else                                 (tr "penforge.qa.error.generic")))

(defn- skipped-text
  [{:keys [name reason]}]
  (case reason
    "board-missing" (tr "penforge.qa.skipped.board-missing" name)
    "dynamic-route" (tr "penforge.qa.skipped.dynamic-route" name)
    name))

(mf/defc screen-card*
  {::mf/private true}
  [{:keys [screen developer]}]
  (let [{:keys [name route score before passed images paths pixel-diff ssim changed-files]} screen]
    [:li {:class (stl/css :screen)}
     [:div {:class (stl/css :screen-header)}
      [:span {:class (stl/css :screen-name)} name]
      (when developer
        [:code {:class (stl/css :screen-route)} route])
      [:span {:class (stl/css-case :score true
                                   :score-ok passed
                                   :score-off (not passed))
              :title (tr "penforge.qa.score-hint")}
       (if passed
         (tr "penforge.qa.score.matches" score)
         (tr "penforge.qa.score.differs" score))]]
     (when (some? before)
       [:p {:class (stl/css :screen-note)} (tr "penforge.qa.before" before score)])
     (when images
       [:div {:class (stl/css :images)}
        [:figure {:class (stl/css :figure)}
         [:img {:class (stl/css :image) :src (:design images) :alt (tr "penforge.qa.design-alt" name)}]
         [:figcaption {:class (stl/css :caption)} (tr "penforge.qa.design")]]
        [:figure {:class (stl/css :figure)}
         [:img {:class (stl/css :image) :src (:app images) :alt (tr "penforge.qa.app-alt" name)}]
         [:figcaption {:class (stl/css :caption)} (tr "penforge.qa.app")]]
        [:figure {:class (stl/css :figure)}
         [:img {:class (stl/css :image) :src (:diff images) :alt (tr "penforge.qa.diff-alt" name)}]
         [:figcaption {:class (stl/css :caption)} (tr "penforge.qa.diff")]]])
     (when developer
       [:p {:class (stl/css :screen-meta)}
        (str (tr "penforge.qa.metrics" (str pixel-diff " %") ssim)
             (when (seq changed-files) (str " · " (tr "penforge.qa.changed-files" (count changed-files))))
             (when paths (str " · " (:diff paths))))])]))

(mf/defc qa-view*
  "Body of the panel for a QA state map (pure: no store access)."
  [{:keys [qa persona on-auto-run-change]}]
  (let [{:keys [status mode progress activity result settings]} qa
        running   (= status :running)
        developer (= persona :developer)
        [matching total] (qa/match-counts result)]
    [:div {:class (stl/css :content)}
     (when running
       [:div {:class (stl/css :progress) :role "status"}
        (if progress
          (progress-text progress)
          (if (= mode :fix) (tr "penforge.qa.fixing") (tr "penforge.qa.checking")))
        (when (and developer activity)
          [:span {:class (stl/css :activity)} activity])])

     (when (= status :error)
       [:> context-notification* {:level (if (= (:error qa) "cancelled") :info :error)}
        (error-text qa developer)])

     (when result
       [:*
        [:> context-notification* {:level (if (:passed result) :success :warning)}
         (if (:passed result)
           (tr "penforge.qa.all-match" total)
           (tr "penforge.qa.some-differ" matching total))]
        [:p {:class (stl/css :scope)}
         (tr "penforge.qa.threshold" (:threshold result))
         (when (and (= "fix" (:mode result)) (:commit result))
           [:span " " (tr "penforge.qa.saved")])
         (when (and (= "fix" (:mode result)) (:checkpoint result))
           [:span " " (tr "penforge.qa.undo-hint")])]
        [:ul {:class (stl/css :screens)}
         (for [screen (:screens result)]
           [:> screen-card* {:key (:board-id screen)
                             :screen screen
                             :developer developer}])]
        (when (seq (:skipped-screens result))
          [:ul {:class (stl/css :skipped)}
           (for [screen (:skipped-screens result)]
             [:li {:key (:board-id screen)} (skipped-text screen)])])])

     (when (and (not running) (nil? result) (not= status :error))
       [:p {:class (stl/css :scope)} (tr "penforge.qa.intro")])

     [:div {:class (stl/css :options)}
      [:> switch* {:key (str (boolean (:auto-run-after-build settings)))
                   :label (tr "penforge.qa.auto-run")
                   :default-checked (boolean (:auto-run-after-build settings))
                   :disabled running
                   :on-change on-auto-run-change}]]]))

(mf/defc qa-footer*
  "Buttons of the panel for a QA state map (pure: no store access)."
  [{:keys [qa on-stop on-check on-fix on-keep-fixing on-accept on-close]}]
  (let [{:keys [status result]} qa
        running  (= status :running)
        failing  (seq (qa/failing-board-ids result))
        fixed    (= "fix" (:mode result))]
    [:div {:class (stl/css :modal-footer)}
     (cond
       running
       [:> button* {:variant "secondary" :on-click on-stop}
        (tr "penforge.qa.stop")]

       :else
       [:> button* {:variant "secondary" :on-click on-check}
        (tr "penforge.qa.check-again")])
     (when (and (not running) failing)
       [:> button* {:variant "secondary" :on-click on-accept}
        (tr "penforge.qa.accept")])
     (cond
       (and (not running) failing fixed)
       [:> button* {:variant "primary" :on-click on-keep-fixing}
        (tr "penforge.qa.keep-fixing")]

       (and (not running) failing)
       [:> button* {:variant "primary" :on-click on-fix}
        (tr "penforge.qa.fix")]

       :else
       [:> button* {:variant "primary" :disabled running :on-click on-close}
        (tr "penforge.qa.done")])]))

(mf/defc qa-panel*
  {::mf/register modal/components
   ::mf/register-as :penforge-qa}
  []
  (let [state   (mf/deref ref:qa)
        persona (mf/deref ref:persona)

        on-close       (mf/use-fn #(st/emit! (modal/hide)))
        on-stop        (mf/use-fn #(st/emit! (qa/cancel)))
        on-check       (mf/use-fn #(st/emit! (qa/check)))
        on-fix         (mf/use-fn #(st/emit! (qa/fix)))
        on-keep-fixing (mf/use-fn #(st/emit! (qa/keep-fixing)))
        on-accept      (mf/use-fn #(st/emit! (qa/accept)))
        on-auto-run    (mf/use-fn #(st/emit! (qa/set-auto-run %)))]

    [:div {:class (stl/css :modal-overlay)}
     [:div {:class (stl/css :modal-container)
            :role "dialog"
            :aria-labelledby "penforge-qa-title"
            :data-testid "ai-visual-qa-panel"}
      [:div {:class (stl/css :modal-header)}
       [:> heading* {:level 2
                     :id "penforge-qa-title"
                     :typography "headline-medium"}
        (tr "penforge.qa.title")]
       [:> icon-button* {:variant "ghost"
                         :aria-label (tr "labels.close")
                         :on-click on-close
                         :icon i/close}]]

      [:> qa-view* {:qa state
                    :persona persona
                    :on-auto-run-change on-auto-run}]

      [:> qa-footer* {:qa state
                      :on-stop on-stop
                      :on-check on-check
                      :on-fix on-fix
                      :on-keep-fixing on-keep-fixing
                      :on-accept on-accept
                      :on-close on-close}]]]))
