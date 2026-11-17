;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.detached.window
  "Renders the chat of the workspace tab into the detached window.

  Runs in the workspace tab: the React root lives here and is bound to
  this tab's store; only its DOM container sits in the detached
  window's document (same origin), which already loaded the app styles
  and icon sprite. See `app.main.data.ai.detached`."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.logging :as log]
   [app.main.data.ai.detached :as detached]
   [app.main.store :as st]
   [app.main.ui.workspace.ai.chat.panel :refer [chat-panel*]]
   [app.util.i18n :refer [tr]]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private ref:chat
  (l/derived #(get-in % [:penforge :chat]) st/state))

(def ^:private ref:file-name
  (l/derived #(get-in % [:files (:current-file-id %) :name]) st/state))

(mf/defc detached-chat*
  "The chat as shown in the detached window."
  [{:keys [window]}]
  (let [chat      (mf/deref ref:chat)
        file-name (mf/deref ref:file-name)]

    (mf/with-effect [window file-name]
      (when-let [document (some-> ^js window .-document)]
        (set! (.-title document)
              (if (seq file-name)
                (tr "penforge.detached.window-title" file-name)
                (tr "penforge.detached.window-title-empty")))))

    (mf/with-layout-effect [chat]
      (detached/log-render-latency!))

    [:div {:class (stl/css :window)}
     [:> chat-panel* {}]]))

(defonce ^:private current-root
  (atom nil))

(defn unmount!
  "Remove the chat from the detached window, if it is there."
  []
  (when-let [{:keys [root container]} @current-root]
    (reset! current-root nil)
    (try
      (mf/unmount! root)
      (catch :default cause
        (log/warn :hint "unable to unmount the detached chat" :cause cause)))
    (.remove ^js container)))

(defn mount!
  "Render the chat into the document of `window` (replacing an earlier
  render). The container covers the window page, which only shows a
  waiting message."
  [^js window]
  (unmount!)
  (let [document  (.-document window)
        container (.createElement document "div")]
    (set! (.-className container) (stl/css :root))
    (.setAttribute container "data-testid" "ai-detached-chat")
    (.appendChild (.-body document) container)
    (let [root (mf/create-root container)]
      (reset! current-root {:root root :container container})
      (mf/render! root (mf/element detached-chat* #js {:window window})))))

(detached/set-renderer! {:mount mount! :unmount unmount!})
