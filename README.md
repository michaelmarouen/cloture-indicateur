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
```

Les contributions sont les bienvenues (licence MIT).
