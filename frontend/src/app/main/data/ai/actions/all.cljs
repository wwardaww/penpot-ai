;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.all
  "Loads every AI action namespace so its actions get registered.
  Append-only: each feature adds one require line for its own
  `app.main.data.ai.actions.<name>` namespace, keeping the list sorted."
  (:require
   [app.main.data.ai.actions.adapt]
   [app.main.data.ai.actions.ask]
   [app.main.data.ai.actions.audit]
   [app.main.data.ai.actions.auto-name]
   [app.main.data.ai.actions.build]
   [app.main.data.ai.actions.chat]
   [app.main.data.ai.actions.comments]
   [app.main.data.ai.actions.design-md]
   [app.main.data.ai.actions.detached]
   [app.main.data.ai.actions.generate]
   [app.main.data.ai.actions.token-sync]
   ;; W15: registers the audit results modal
   [app.main.ui.workspace.ai.audit.panel]
   [app.main.ui.workspace.ai.build.actions]
   ;; W19: AI history dialog; requires app.main.data.ai.actions.checkpoints
   [app.main.ui.workspace.ai.checkpoints.history]))
