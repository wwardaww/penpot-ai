;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.header-strip
  "Header buttons of the AI actions registered with the `:header`
  scope (right workspace header)."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.actions :as actions]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(mf/defc header-action*
  {::mf/private true}
  [{:keys [action enabled]}]
  (let [on-click
        (mf/use-fn
         (mf/deps action)
         #(actions/run-action action :header))]
    ;; `:primary` actions (the Build CTA) show their label
    (if (:primary action)
      [:> button* {:variant "primary"
                   :class (stl/css :primary-action)
                   :disabled (not enabled)
                   :on-click on-click}
       (actions/get-label action)]
      [:> icon-button* {:variant "action"
                        :tooltip-placement "bottom-left"
                        :aria-label (actions/get-label action)
                        :icon (or (:icon action) i/feedback)
                        :disabled (not enabled)
                        :on-click on-click}])))

(mf/defc header-strip*
  []
  (let [registry  (mf/deref actions/registry)
        items-ref (mf/with-memo [registry]
                    (l/derived (fn [state]
                                 (->> (actions/get-actions registry :header state)
                                      (mapv (fn [action]
                                              {:action action
                                               :enabled (actions/enabled? action state)}))))
                               st/state
                               =))
        items     (mf/deref items-ref)]
    (when (seq items)
      [:div {:class (stl/css :header-strip)}
       (for [{:keys [action enabled]} items]
         [:> header-action* {:key (str (:id action))
                             :action action
                             :enabled enabled}])])))
