;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.all
  "Loads every AI action namespace so its actions get registered.
  Append-only: each feature adds one require line for its own
  `app.main.data.ai.actions.<name>` namespace."
  (:require
   [app.main.data.ai.actions.chat]
   [app.main.data.ai.actions.ask]))
