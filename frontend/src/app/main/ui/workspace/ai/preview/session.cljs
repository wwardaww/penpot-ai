;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.preview.session
  "Lifecycle of the live preview state of an open workspace file."
  (:require
   [app.main.data.ai.preview :as preview]
   [app.main.store :as st]
   [rumext.v2 :as mf]))

(mf/defc preview-session*
  "Follows the preview of the file's project; renders nothing. Lives
  at file level so that page changes keep the state."
  [{:keys [project-id file-id]}]
  (mf/with-effect [project-id file-id]
    (st/emit! (preview/initialize project-id))
    (fn []
      (st/emit! (preview/finalize))))
  nil)
