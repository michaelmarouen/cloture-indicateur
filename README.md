# cloture-indicateur

A Claude Code mod that tells you, live and per session, whether you can safely close it.
Un mod Claude Code qui indique en direct, pour chaque session, si tu peux la fermer sans rien perdre.

Au-dessus du prompt, un bandeau affiche l'etat git du depot de la session :

- `OK POUR FERMER` : depot propre et pousse.
- `NE PAS FERMER : N non commite(s), N non pousse(s), sans remote/amont, N stash` : il reste du travail a sauver.
- `OK POUR FERMER cote git` : le dossier n'est pas un depot git (rien a pousser, verifie tes fichiers toi-meme).

Le calcul se refait au demarrage de la session, puis toutes les 30 secondes tant que le verdict n'est pas vert (un commit ou un push fait dans un terminal est vu sans attendre la fin d'un tour), et toutes les 2 minutes une fois vert ou hors depot ; un outil qui peut modifier le depot (Bash, Edit, Write, outils MCP) force aussi un recalcul. Il tourne en minuteur : il ne retarde pas la fin du tour. Le bandeau est vert (OK), rouge (NE PAS FERMER) ou jaune (hors depot). Une ligne de statut reprend le verdict, et un toast
apparait quand le depot redevient propre. Le verdict est **par depot** : une autre session qui travaille dans le meme depot
peut avoir des changements non commites qui s'affichent aussi chez toi.

## Installation

Dans un terminal Claude Code :

```
/plugin install cloture-indicateur --marketplace michaelmarouen/cloture-indicateur
```

Ou depuis un shell :

```
claude plugin install cloture-indicateur --marketplace michaelmarouen/cloture-indicateur
```

Dans l'application de bureau, `/plugin` n'existe pas : clique sur +, puis Plugins, Add marketplace avec
`michaelmarouen/cloture-indicateur`, puis Add plugin. Recharge ensuite avec `/reload-plugins` ou ouvre une nouvelle session.

## Bouton « Demander commit+push a la base » (sessions de reprise)

Dans une session de reprise, quand le depot a des fichiers non commites ou non pousses, un bouton envoie un message clair
a la session de base : nom de la reprise, depot, branche, nombre de fichiers, et la demande de commit puis push.

Le mod ne peut pas deviner quelle est la session de base : la session qui lance la reprise doit l'ecrire dans le **premier message** :

```
CLOTURE-BASE: local_<id de la session de base> | <titre de la session de base> | <titre de la reprise>
```

Les deux titres sont facultatifs. Sans ce marqueur, le bouton n'apparait pas. Le mod essaie d'abord `{ sessionId }`, puis l'id comme adresse.

## Bouton « Prévenir les autres sessions du dépôt »

Chaque session ecrit une petite fiche (identifiant, depot, libelle, heure) dans `~/.claude/cloture-registry/`. Quand le depot a des
changements a sauver et que d'autres sessions **vivantes** (fiche reecrite chaque minute, ignoree apres 3 minutes ; une session qui se ferme marque sa fiche comme fermee) travaillent sur le meme depot, le bandeau les liste
et propose un bouton qui leur envoie un message clair : depot, branche, nombre de fichiers, demande de commit puis push
(ou d'ignorer le message si ces changements ne sont pas les leurs). Ne marche que si le mod est actif dans ces autres sessions.
Apres un envoi (aux autres sessions ou a la session de base), le bandeau passe en suivi rapide : il revérifie le depot toutes les 5 secondes (10 minutes au plus), affiche « j'attends que les autres sessions commitent et poussent », puis passe au vert avec un toast des que tout est commite et pousse.
Le resultat de l'envoi reste affiche sur le bandeau (« ✓ 1/1 session(s) prevenue(s) » ou « ✗ 0/1 ... » avec la raison), et un envoi refuse ou en erreur n'est jamais silencieux. Livre ne veut pas dire lu : l'autre session decide quand agir. Les fiches ne sont pas effacees, juste ignorees quand elles sont perimees.

## Source unique (optionnel)

Si le fichier `~/.claude/scripts/cloture_check.py` existe et accepte `--git-only <dossier>` (il renvoie un JSON `kind`, `dirty`, `ahead`, `stash`, `branch`, `worktrees`), le mod l'utilise comme source de verite et compte aussi les worktrees. Sinon, ou s'il echoue, une logique git integree prend le relais (sans worktrees).

## Limites

- Il ne lit que git (`status`, `rev-list`, `stash list`). Il ne detecte pas un job en cours (build, entrainement...).
- Il ne peut pas ajouter de bouton dans la liste des sessions : l'API des mods ne le permet pas.
- L'API des mods de Claude Code est en acces anticipe et peut changer entre deux versions.

## Developpement

```
claude plugin validate .
claude plugin test .
node --test test/e2e-git.test.mjs
```

Le second test cree de vrais depots git temporaires (propre, non commite, non pousse, sans remote, stash) et verifie que le mod (et `cloture_check.py` s'il existe) donnent le meme verdict. Il demande Node 22.6 ou plus recent.

Les contributions sont les bienvenues (licence MIT).
