;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.chat.banner
  "Connection state of the Penforge agent, with start and pairing help."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.client :as client]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [app.util.keyboard :as kbd]
   [rumext.v2 :as mf]))

(def start-command
  "node mcp/scripts/penforge.mjs")

(mf/defc pair-form*
  {::mf/private true}
  []
  (let [value*    (mf/use-state "")
        value     (deref value*)
        error*    (mf/use-state false)
        error?    (deref error*)
        input-ref (mf/use-ref nil)

        on-change
        (mf/use-fn
         (fn [event]
           (reset! error* false)
           (reset! value* (dom/get-target-val event))))

        ;; Read the input element, not the state: a link pasted and
        ;; submitted with Enter right away can reach this handler before
        ;; the state update renders, which used to submit an empty value.
        on-submit
        (mf/use-fn
         (fn [event]
           (dom/prevent-default event)
           (let [input (mf/ref-val input-ref)]
             (if-let [token (client/parse-pair-input (some-> input dom/get-value))]
               (do
                 (reset! value* "")
                 (st/emit! (client/pair token)))
               (reset! error* true)))))

        on-key-down
        (mf/use-fn
         (mf/deps on-submit)
         (fn [event]
           (when (kbd/enter? event)
             (on-submit event))))]

    [:form {:class (stl/css :pair-form)
            :on-submit on-submit}
     [:input {:class (stl/css :pair-input)
              :ref input-ref
              :type "text"
              :value value
              :spell-check false
              :auto-complete "off"
              :aria-label (tr "penforge.chat.pair.label")
              :placeholder (tr "penforge.chat.pair.placeholder")
              :on-change on-change
              :on-key-down on-key-down}]
     [:> button* {:variant "secondary"
                  :type "submit"
                  :disabled (empty? value)}
      (tr "penforge.chat.pair.submit")]
     (when ^boolean error?
       [:> text* {:as "p"
                  :typography t/body-small
                  :class (stl/css :pair-error)}
        (tr "penforge.chat.pair.invalid")])]))

(mf/defc start-help*
  {::mf/private true}
  []
  [:ol {:class (stl/css :steps)}
   [:li {:class (stl/css :step)}
    [:> text* {:as "span" :typography t/body-small}
     (tr "penforge.chat.help.start")]
    [:code {:class (stl/css :command)} start-command]]
   [:li {:class (stl/css :step)}
    [:> text* {:as "span" :typography t/body-small}
     (tr "penforge.chat.help.pair")]
    [:> pair-form* {}]]])

(mf/defc connection-banner*
  [{:keys [connection]}]
  (let [{:keys [status reason]} connection

        on-retry
        (mf/use-fn #(st/emit! (client/connect)))]

    ;; `cond`, not `case`: the rumext compiler drops the literal `nil`
    ;; branch inside `case`, which shifts the clause pairs and makes the
    ;; component throw "No matching clause".
    (cond
      (= status :connected)
      nil

      (= status :pairing)
      [:div {:class (stl/css :banner :banner-inline)}
       [:span {:class (stl/css :spinner) :aria-hidden true}]
       [:> text* {:as "span" :typography t/body-small}
        (tr "penforge.chat.status.connecting")]]

      :else
      [:section {:class (stl/css :banner)}
       [:> text* {:as "h3"
                  :typography t/headline-small
                  :class (stl/css :title)}
        (case reason
          :auth-error (tr "penforge.chat.status.pair-expired")
          (:unreachable :closed) (tr "penforge.chat.status.unreachable")
          (tr "penforge.chat.status.not-paired"))]

       [:> text* {:as "p"
                  :typography t/body-small
                  :class (stl/css :description)}
        (case reason
          :auth-error (tr "penforge.chat.status.pair-expired-hint")
          (:unreachable :closed) (tr "penforge.chat.status.unreachable-hint")
          (tr "penforge.chat.status.not-paired-hint"))]

       [:> start-help* {}]

       (when (contains? #{:unreachable :closed} reason)
         [:> button* {:variant "secondary"
                      :icon i/reload
                      :on-click on-retry}
          (tr "penforge.chat.status.retry")])])))
