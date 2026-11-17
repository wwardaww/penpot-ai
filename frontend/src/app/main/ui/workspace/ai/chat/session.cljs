;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.chat.session
  "Lifecycle of the Penforge AI session of an open workspace file."
  (:require
   [app.main.data.ai.actions.all]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.client :as client]
   [app.main.store :as st]
   [rumext.v2 :as mf]))

(mf/defc ai-session*
  "Starts the daemon client and the chat of the file; renders nothing."
  [{:keys [file-id]}]
  (mf/with-effect [file-id]
    (st/emit! (client/initialize)
              (chat/initialize file-id))
    (fn []
      (st/emit! (chat/finalize)
                (client/finalize))))
  nil)
