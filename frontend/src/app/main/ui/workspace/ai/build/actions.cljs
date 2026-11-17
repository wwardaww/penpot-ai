;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.build.actions
  "Loads the Build dialog (W08) so its modal is registered. The one
  Build action, `:ai/build` (header button, main menu, command
  palette), lives in `app.main.data.ai.actions.build` (W09) and opens
  this dialog through `app.main.ui.workspace.ai.build.events/start`."
  (:require
   [app.main.ui.workspace.ai.build.dialog]))
