;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.animations.settings
  "Animation settings dialog (W32): one project setting, \"AI may add
  animations\" (on by default). The daemon keeps it in the project's
  `.penforge/project.json`; the dialog reads and writes it with the
  workflow `animation-settings`. With it off, the AI animates only
  when the user asks.

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
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def workflow-name "animation-settings")

(defn next-state
  "Dialog state after a daemon message of the current run. Steps:
  `:loading`, `:ready`, `:saving`, `:error`."
  [state {:keys [type kind payload ok summary error code message]}]
  (cond
    (and (= type "workflow.event") (= kind "result") (boolean? (:ai-animations payload)))
    (assoc state :value (:ai-animations payload))

    (= type "workflow.done")
    (if ok
      (assoc state :step :ready :error nil)
      (assoc state :step :error :error (or error summary)))

    (= type "error")
    (assoc state :step :error :error (or message code))

    :else
    state))

(defn save-params
  "Params of the run that stores `value`."
  [value]
  {:ai-animations (boolean value)})

(def ^:private ref:connected
  (l/derived #(= :connected (get-in % [:penforge :connection :status])) st/state))

(mf/defc animation-settings-dialog
  "Modal `:penforge-animation-settings`."
  {::mf/register modal/components
   ::mf/register-as :penforge-animation-settings}
  []
  (let [connected (mf/deref ref:connected)

        state*  (mf/with-memo [] (atom {:step :loading}))
        state   (mf/deref state*)
        {:keys [step value error]} state

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
             (st/emit! (chat/run-workflow workflow-name params {:rid rid :silent true})))))

        handle-change
        (mf/use-fn
         (mf/deps state* start!)
         (fn [_]
           (let [value (not (:value @state*))]
             (swap! state* assoc :step :saving :value value)
             (start! (save-params value)))))

        handle-close
        (mf/use-fn (fn [_] (modal/hide!)))]

    (mf/with-effect [connected]
      (when (and connected (= :loading (:step @state*)) (nil? (mf/ref-val subscription)))
        (start! {})))

    (mf/with-effect [state*]
      (fn []
        (some-> (mf/ref-val subscription) rx/dispose!)))

    [:div {:class (stl/css :modal-overlay)}
     [:div {:class (stl/css :modal-dialog)
            :role "dialog"
            :aria-labelledby "penforge-animation-settings-title"
            :data-testid "penforge-animation-settings"}
      [:> icon-button* {:variant "ghost"
                        :tooltip-class (stl/css :close-btn)
                        :aria-label (tr "labels.close")
                        :icon i/close
                        :on-click handle-close}]
      [:div {:class (stl/css :modal-title) :id "penforge-animation-settings-title"}
       (tr "penforge.animations.settings.title")]

      [:div {:class (stl/css :modal-content)}
       (cond
         (not connected)
         [:> context-notification* {:level :warning :appearance :ghost}
          (tr "penforge.animations.settings.not-connected")]

         (and (= step :loading) (nil? value))
         [:div {:class (stl/css :progress)}
          [:> loader* {:width 32 :title (tr "penforge.animations.settings.loading")}]]

         :else
         [:*
          [:> checkbox* {:id "penforge-ai-animations"
                         :label (tr "penforge.animations.settings.initiative")
                         :checked (boolean value)
                         :disabled (= step :saving)
                         :on-change handle-change}]
          [:> text* {:as "p" :typography t/body-small :class (stl/css :hint)}
           (tr "penforge.animations.settings.hint")]
          (when (= step :error)
            [:> context-notification* {:level :error :appearance :ghost}
             (tr "penforge.animations.settings.error" (str error))])])]

      [:div {:class (stl/css :modal-footer)}
       [:> button* {:variant "primary" :on-click handle-close}
        (tr "labels.close")]]]]))
