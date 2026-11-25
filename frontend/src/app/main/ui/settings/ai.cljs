;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.settings.ai
  "AI page of the account settings: the Claude command and the permission
  mode, which the Penforge daemon keeps."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.client :as client]
   [app.main.data.ai.settings :as settings]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.controls.input :refer [input*]]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.heading :refer [heading*]]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.main.ui.ds.notifications.context-notification :refer [context-notification*]]
   [app.main.ui.workspace.ai.permission-mode :refer [permission-mode-switch*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(defn- error-text
  [{:keys [code reason]}]
  (cond
    (= reason "claude-command") (tr "penforge.settings.command.invalid")
    (= code "not-connected")    (tr "penforge.settings.not-connected")
    (= code "forbidden")        (tr "penforge.settings.command.forbidden")
    :else                       (tr "penforge.settings.failed")))

(defn- found-text
  [{:keys [kind path version]}]
  (let [where (case kind
                "alias"    (tr "penforge.settings.command.found-alias")
                "function" (tr "penforge.settings.command.found-function")
                "bundled"  (tr "penforge.settings.command.found-bundled")
                (tr "penforge.settings.command.found-program" (or path "")))]
    (if (some? version)
      (str (tr "penforge.settings.command.version" version) " " where)
      where)))

(defn test-result
  "Level and text of the result of a test of the Claude command, or nil
  while there is none."
  [{:keys [status found problem error claude-command] :as check}]
  (case status
    :failed
    {:level :error :text (error-text error)}

    :done
    (cond
      (or (not found) (= problem "not-found"))
      {:level :error :text (tr "penforge.settings.command.not-found" claude-command)}

      (= problem "not-started")
      {:level :error :text (tr "penforge.settings.command.not-started")}

      (= problem "timeout")
      {:level :error :text (tr "penforge.settings.command.timeout")}

      (some? problem)
      {:level :error :text (tr "penforge.settings.command.not-claude")}

      :else
      {:level :success :text (found-text check)})

    nil))

(mf/defc claude-command-form*
  {::mf/private true}
  [{:keys [command save check connected]}]
  (let [value*   (mf/use-state command)
        value    (deref value*)
        changed? (not= (str/trim value) command)
        testing? (= :pending (:status check))
        result   (test-result check)

        on-change
        (mf/use-fn
         (fn [event]
           (st/emit! (settings/clear-results))
           (reset! value* (dom/get-target-val event))))

        on-submit
        (mf/use-fn
         (mf/deps value)
         (fn [event]
           (dom/prevent-default event)
           (st/emit! (settings/save-claude-command value))))

        on-test
        (mf/use-fn
         (mf/deps value)
         #(st/emit! (settings/check-claude-command value)))]

    ;; another tab saved another command, or an empty one became the default
    (mf/with-effect [command]
      (reset! value* command))

    [:form {:class (stl/css :form)
            :on-submit on-submit}
     [:> input* {:label (tr "penforge.settings.command.label")
                 :value value
                 :placeholder "claude"
                 :spell-check false
                 :auto-complete "off"
                 :auto-capitalize "off"
                 :hint-message (if (= :failed (:status save))
                                 (error-text (:error save))
                                 (tr "penforge.settings.command.hint"))
                 :hint-type (if (= :failed (:status save)) "error" "hint")
                 :variant "comfortable"
                 :data-testid "penforge-claude-command"
                 :on-change on-change}]
     [:div {:class (stl/css :actions)}
      [:> button* {:variant "primary"
                   :type "submit"
                   :disabled (or (not connected) (not changed?) (= :pending (:status save)))}
       (tr "penforge.settings.command.save")]
      [:> button* {:variant "secondary"
                   :type "button"
                   :disabled (or (not connected) testing?)
                   :on-click on-test}
       (if testing?
         (tr "penforge.settings.command.testing")
         (tr "penforge.settings.command.test"))]
      (when (and (= :saved (:status save)) (not changed?))
        [:> text* {:as "span"
                   :typography t/body-small
                   :class (stl/css :muted)
                   :role "status"}
         (tr "penforge.settings.command.saved")])]
     (when (some? result)
       [:div {:role "status"}
        [:> context-notification* {:level (:level result)}
         (:text result)]])]))

(mf/defc ai-page*
  []
  (let [state     (mf/deref settings/ref:settings)
        connected (mf/deref settings/ref:connected)
        {:keys [scope claude-command save test]} state]

    (mf/with-effect []
      (dom/set-html-title (tr "title.settings.ai"))
      (st/emit! (client/initialize))
      #(st/emit! (settings/clear-results)
                 (client/finalize)))

    [:section {:class (stl/css :ai-page)
               :aria-labelledby "ai-section-title"}
     [:> heading* {:level 2
                   :typography t/title-large
                   :class (stl/css :title)
                   :id "ai-section-title"}
      (tr "penforge.settings.title")]

     (when-not connected
       [:> context-notification* {:level :warning}
        (tr "penforge.settings.not-connected")])

     (when (some? state)
       [:section {:class (stl/css :group)}
        [:> heading* {:level 3
                      :typography t/headline-small
                      :class (stl/css :title)}
         (tr "penforge.settings.mode.title")]
        [:> permission-mode-switch* {}]
        [:> text* {:as "p" :typography t/body-medium :class (stl/css :muted)}
         (tr "penforge.settings.mode.manual-hint")]
        [:> text* {:as "p" :typography t/body-medium :class (stl/css :muted)}
         (tr "penforge.settings.mode.auto-hint")]
        [:> text* {:as "p" :typography t/body-medium :class (stl/css :muted)}
         (tr "penforge.settings.mode.limits")]
        (when (= :session scope)
          [:> text* {:as "p" :typography t/body-medium :class (stl/css :muted)}
           (tr "penforge.settings.mode.session")])])

     (when (some? claude-command)
       [:section {:class (stl/css :group)}
        [:> heading* {:level 3
                      :typography t/headline-small
                      :class (stl/css :title)}
         (tr "penforge.settings.command.title")]
        [:> claude-command-form* {:command claude-command
                                  :save save
                                  :check test
                                  :connected connected}]])]))
