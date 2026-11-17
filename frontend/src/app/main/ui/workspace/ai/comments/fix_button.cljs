;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.comments.fix-button
  "\"Fix with AI\" button of a comment thread popover (W07)."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.actions.comments :as ai-comments]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(defn- get-label
  [status]
  (cond
    (= status :running)   (tr "penforge.comments.fixing")
    (= status :fixed)     (tr "penforge.comments.fixed")
    (= status :no-change) (tr "penforge.comments.no-change")
    (= status :unchanged) (tr "penforge.comments.unchanged")
    (some? status)        (tr "penforge.comments.fix-failed")
    :else                 (tr "penforge.comments.fix-with-ai")))

(defn- get-title
  [status note]
  (cond
    (some? note)          note
    (= status :running)   (tr "penforge.comments.fixing")
    (contains? #{:failed :error} status) (tr "penforge.comments.fix-retry")
    :else                 (tr "penforge.comments.fix-with-ai.hint")))

(mf/defc fix-with-ai-button*
  "Asks the AI to apply the change the thread asks for. Shown only with
  the `:ai` flag, a connected daemon and edit rights; keeps showing the
  outcome of the last fix. Disabled while a \"Fix comments\" batch runs."
  [{:keys [thread]}]
  (let [thread-id (:id thread)
        can-fix   (mf/deref (mf/with-memo [] (l/derived ai-comments/can-fix? st/state)))
        batch     (mf/deref (mf/with-memo [] (l/derived ai-comments/batch-running? st/state)))
        fix-ref   (mf/with-memo [thread-id]
                    (l/derived #(ai-comments/get-thread-fix % thread-id) st/state))
        fix       (mf/deref fix-ref)
        status    (:status fix)
        resolved  (:is-resolved thread)

        disabled  (or (not can-fix)
                      batch
                      (= status :running)
                      (and resolved (= status :fixed)))

        on-click
        (mf/use-fn
         (mf/deps thread)
         (fn [event]
           (dom/stop-propagation event)
           (st/emit! (ai-comments/fix-thread thread))))]

    (when (and (some? thread-id)
               (or (some? status)
                   (and can-fix (not resolved))))
      [:> button* {:variant "ghost"
                   :class (stl/css-case :fix-button true
                                        :fix-button-running (= status :running))
                   :icon (if (= status :fixed) i/tick i/feedback)
                   :title (get-title status (:note fix))
                   :aria-busy (= status :running)
                   :data-testid "comment-fix-with-ai"
                   :disabled disabled
                   :on-click on-click}
       (get-label status)])))
