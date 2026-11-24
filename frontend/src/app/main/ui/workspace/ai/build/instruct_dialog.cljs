;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.build.instruct-dialog
  "The Instruct dialog (W41): what will be written and where, progress,
  the result and errors. `instruct-view*` renders from plain props
  (tests render it)."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.chat :as chat]
   [app.main.data.modal :as modal]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.main.ui.workspace.ai.build.instruct :as instruct]
   [app.main.ui.workspace.ai.build.output :as output]
   [app.main.ui.workspace.ai.build.output-dialog :refer [output-line*]]
   [app.util.i18n :refer [tr]]
   [cuerdas.core :as str]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private ref:instruct
  (l/derived instruct/get-instruct st/state))

(defn step-text
  "Translated text of a progress step; the daemon's English text for
  unknown steps."
  [{:keys [step params text]}]
  (let [{:keys [done total name]} params]
    (case step
      "screens" (tr "penforge.instruct.step.screens" (str name) (inc (or done 0)) (or total 0))
      "assets"  (tr "penforge.instruct.step.assets")
      "tokens"  (tr "penforge.instruct.step.tokens")
      "guides"  (tr "penforge.instruct.step.guides" (or done 0) (or total 0))
      "write"   (tr "penforge.instruct.step.write")
      text)))

(defn get-error-text
  [{:keys [failure-code error]}]
  (cond
    (= failure-code "no-screens")     (tr "penforge.instruct.error.no-screens")
    (= failure-code "busy")           (tr "penforge.instruct.error.busy")
    (contains? #{"no-folder" "folder-missing" "folder-refused" "folder-taken"} failure-code)
    (tr "penforge.instruct.error.folder")
    (= error "not-connected")         (tr "penforge.build.error.not-connected")
    :else                             (tr "penforge.instruct.error.generic")))

(mf/defc confirm-body*
  {::mf/private true}
  [{:keys [plan on-change-folder]}]
  (let [screens (:screens plan)]
    [:*
     [:> text* {:as "p" :typography t/body-medium :class (stl/css :text)}
      (tr "penforge.instruct.intro")]
     [:> output-line* {:purpose :instruct
                       :on-change on-change-folder}]
     (if (seq screens)
       [:> text* {:as "p" :typography t/body-small :class (stl/css :text :muted)}
        (tr "penforge.instruct.screens" (count screens))]
       [:> text* {:as "p" :typography t/body-small :class (stl/css :text :muted)}
        (tr "penforge.instruct.error.no-screens")])]))

(mf/defc done-body*
  {::mf/private true}
  [{:keys [result]}]
  (let [{:keys [folder screens assets kept]} result
        missing (remove :captured screens)]
    [:*
     [:div {:class (stl/css :done)}
      [:> icon* {:icon-id i/tick :size "l" :class (stl/css :done-icon)}]
      [:> text* {:as "p" :typography t/headline-small :class (stl/css :text)}
       (tr "penforge.instruct.done.title")]]
     [:> text* {:as "p" :typography t/body-medium :class (stl/css :text)}
      (tr "penforge.instruct.done.summary" (count screens) (or assets 0))]
     [:p {:class (stl/css :path)} folder]
     (when (seq missing)
       [:p {:class (stl/css :muted) :role "alert"}
        (tr "penforge.instruct.done.missing" (str/join ", " (map :name missing)))])
     (when (seq kept)
       [:p {:class (stl/css :muted)}
        (tr "penforge.instruct.done.kept" (count kept))])]))

(mf/defc instruct-view*
  "Content of the dialog for a state."
  [{:keys [instruct on-confirm on-cancel on-close on-retry on-open-ai on-change-folder]}]
  (let [{:keys [stage plan result progress error failure-code]} instruct]
    (case stage
      :planning
      [:*
       [:div {:class (stl/css :body) :aria-busy true}
        [:> text* {:as "p" :typography t/body-medium :class (stl/css :text)}
         (tr "penforge.instruct.planning")]]
       [:footer {:class (stl/css :footer)}
        [:> button* {:variant "secondary" :on-click on-cancel}
         (tr "penforge.build.stop")]]]

      :confirm
      [:*
       [:div {:class (stl/css :body)
              :data-testid "penforge-instruct-confirm"}
        [:> confirm-body* {:plan plan :on-change-folder on-change-folder}]]
       [:footer {:class (stl/css :footer)}
        [:> button* {:variant "secondary" :on-click on-cancel}
         (tr "penforge.build.plan.not-now")]
        [:> button* {:variant "primary"
                     :disabled (empty? (:screens plan))
                     :on-click on-confirm}
         (tr "penforge.instruct.confirm")]]]

      :running
      [:*
       [:div {:class (stl/css :body) :aria-busy true}
        [:> text* {:as "p" :typography t/body-medium :class (stl/css :text)}
         (tr "penforge.instruct.running")]
        [:p {:class (stl/css :muted) :aria-live "polite"}
         (step-text progress)]]
       [:footer {:class (stl/css :footer)}
        [:> button* {:variant "secondary" :on-click on-cancel}
         (tr "penforge.build.stop")]
        [:> button* {:variant "primary" :on-click on-close}
         (tr "penforge.build.hide")]]]

      :done
      [:*
       [:div {:class (stl/css :body)
              :data-testid "penforge-instruct-done"}
        [:> done-body* {:result result}]]
       [:footer {:class (stl/css :footer)}
        [:> button* {:variant "primary" :on-click on-close}
         (tr "penforge.build.close")]]]

      :error
      [:*
       [:div {:class (stl/css :body)}
        [:p {:class (stl/css :error) :role "alert"}
         (get-error-text {:failure-code failure-code :error error})]]
       [:footer {:class (stl/css :footer)}
        [:> button* {:variant "secondary" :on-click on-cancel}
         (tr "penforge.build.close")]
        (if (= error "not-connected")
          [:> button* {:variant "primary" :on-click on-open-ai}
           (tr "penforge.build.error.open-ai")]
          [:> button* {:variant "primary" :on-click on-retry}
           (tr "penforge.build.error.retry")])]]

      nil)))

(mf/defc instruct-dialog*
  {::mf/register modal/components
   ::mf/register-as instruct/modal-type}
  []
  (let [state            (mf/deref ref:instruct)
        on-confirm       (mf/use-fn #(st/emit! (instruct/confirm)))
        on-cancel        (mf/use-fn #(st/emit! (instruct/cancel)))
        on-close         (mf/use-fn #(st/emit! (instruct/close)))
        on-retry         (mf/use-fn #(st/emit! (instruct/start)))
        on-open-ai       (mf/use-fn #(st/emit! (modal/hide) (chat/open-chat)))
        on-change-folder (mf/use-fn
                          #(st/emit! (output/change-folder :instruct instruct/start-plan instruct/reopen)))]
    [:div {:class (stl/css :modal-overlay)}
     [:div {:class (stl/css :modal-dialog)
            :role "dialog"
            :aria-labelledby "penforge-instruct-title"
            :data-testid "penforge-instruct-dialog"}
      [:header {:class (stl/css :header)}
       [:> text* {:as "h2" :id "penforge-instruct-title"
                  :typography t/headline-medium :class (stl/css :title)}
        (tr "penforge.instruct.title")]
       [:> icon-button* {:variant "ghost"
                         :icon i/close
                         :aria-label (tr "penforge.build.close")
                         :on-click on-close}]]
      [:> instruct-view* {:instruct state
                          :on-confirm on-confirm
                          :on-cancel on-cancel
                          :on-close on-close
                          :on-retry on-retry
                          :on-open-ai on-open-ai
                          :on-change-folder on-change-folder}]]]))
