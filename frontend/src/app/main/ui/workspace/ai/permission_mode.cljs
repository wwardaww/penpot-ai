;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.permission-mode
  "Switch of the AI's permission mode, for the settings page and the chat
  header."
  (:require
   [app.main.data.ai.settings :as settings]
   [app.main.store :as st]
   [app.main.ui.ds.controls.radio-buttons :refer [radio-buttons*]]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(defn- mode-label
  [mode]
  (case mode
    :auto (tr "penforge.settings.mode.auto")
    (tr "penforge.settings.mode.manual")))

(defn- mode-hint
  [mode]
  (case mode
    :auto (tr "penforge.settings.mode.auto-hint")
    (tr "penforge.settings.mode.manual-hint")))

(defn parse-mode
  "The mode of a radio button value, or nil."
  [value]
  (some #(when (= value (name %)) %) settings/permission-modes))

(mf/defc permission-mode-switch*
  "Shows the permission mode and switches it. Renders nothing until the
  daemon said which mode holds. `class` goes to the wrapper."
  [{:keys [class]}]
  (let [mode      (:permission-mode (mf/deref settings/ref:settings))
        connected (mf/deref settings/ref:connected)
        id        (mf/use-id)

        options
        (mf/with-memo [id]
          (mapv (fn [mode]
                  {:id (str id "-" (name mode))
                   :value (name mode)
                   :label (mode-label mode)})
                settings/permission-modes))

        on-change
        (mf/use-fn
         (fn [value]
           (when-let [mode (parse-mode value)]
             (st/emit! (settings/set-permission-mode mode)))))]

    (when (some? mode)
      [:div {:class class
             :role "group"
             :aria-label (tr "penforge.settings.mode.title")
             :title (mode-hint mode)
             :data-testid "penforge-permission-mode"}
       [:> radio-buttons* {:name (str "penforge-permission-mode-" id)
                           :selected (name mode)
                           :disabled (not connected)
                           :options options
                           :on-change on-change}]])))
