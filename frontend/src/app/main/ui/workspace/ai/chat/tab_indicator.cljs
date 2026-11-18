;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.chat.tab-indicator
  "Working indicator on the AI tab of the left sidebar (W25).

  The sidebar's tab switcher (design system) takes plain text labels, so
  instead of changing it this component marks the document body with
  `data-penforge-ai` (`working` or `waiting`) while the AI works and the
  chat is not in view (another tab is open, or the chat is detached).
  `tab_indicator.scss` draws a dot on the AI tab from that attribute."
  (:require
   [app.main.data.ai.chat :as chat]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.workspace.ai.detached.placeholder :refer [ref:detached?]]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private attribute "data-penforge-ai")

(def ^:private ref:state
  (l/derived (fn [state]
               (let [chat (get-in state [:penforge :chat])]
                 (cond
                   (not (chat/working? chat)) nil
                   (chat/waiting? chat) "waiting"
                   :else "working")))
             st/state))

(defn indicator-state
  "Value of the body attribute: the AI's `state` (\"working\",
  \"waiting\" or nil) while the chat is out of view, else nil."
  [state chat-visible]
  (when-not chat-visible state))

(mf/defc tab-indicator*
  "Marks the document body while the AI works out of view; renders
  nothing visible itself."
  []
  (let [state    (mf/deref ref:state)
        layout   (mf/deref refs/workspace-layout)
        detached (mf/deref ref:detached?)
        value    (indicator-state state (and (contains? layout :ai-chat)
                                             (not (contains? layout :collapse-left-sidebar))
                                             (not detached)))]
    (mf/with-effect [value]
      (when-let [body (.-body js/document)]
        (if value
          (.setAttribute body attribute value)
          (.removeAttribute body attribute))
        #(.removeAttribute body attribute)))
    nil))
