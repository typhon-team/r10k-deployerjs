/*
  This code handle the "modify" event. The process is as follows:
    - clone the repo
    - fetch (and pruning)
    - checkout the branch. If it already exists, we merge potential changes from the production branch
    - update the module ref in Puppetfile if needed
    - commit the changes in Puppetfile if needed
    - push the changes upstream if needed
    - invoke r10k
      - update the module in 'feature' environment (most of the time)
      - update all modules in 'feature' environment if there were changes merged from the 'production' branch so that our 'feature' environment reflects those changes
*/

var promisify = require('promisify-node');
var fse = promisify(require('fs-extra'));
var logger = require('../logger');
var GU = require('./git_utils');
var RD = require('../r10k/rundeck');


/*
  eventData: object containing the name of the branch, the name of the module, the repo URL and the type of event
  cbk: represents the "done" callback used by kue to know when an error occured during job processing
*/
var runModify = function *(eventData, cbk) {

  var now = Date.now();
  var basedir = process.cwd();
  var new_content;
  var fullDeploymentNeeded = false;
  var commitNeeded = false;
  var gitdir = '/var/tmp/puppetfile_repo_'+now;
  var gitopts = { cwd: gitdir };
  var pfile = gitdir+'/Puppetfile';
  var pfileRepo = eventData.pfrepo;
  var branchName = eventData.branch;
  var defaultBranch = process.env.PUPPETFILE_GIT_DEFAULT_BRANCH || 'production';
  if (branchName == 'production') {
    var puppetfileBranchName = defaultBranch;
  } else {
    var puppetfileBranchName = branchName;
  }
  var moduleName = eventData.reponame;
  var pushUsername = eventData.pushuser;
  var repoUrl = eventData.repourl;
  var rundeck_data = { "pushUsername": pushUsername, "branch": puppetfileBranchName, "module": moduleName, "path": eventData.repopath, "repoUrl": repoUrl};
  var module_regex = new RegExp('('+repoUrl+'[\'"],\\s*:ref\\s*=>\\s*[\'"])([^\'"]+)([\'"]\\s*)$', 'gm');

  try {

    logger.info('Entering "modify_action" process for branch '+puppetfileBranchName+' of module '+moduleName);

    // Clone the repository
    yield* GU.clone(gitdir, pfileRepo);

    // Fetch from remote
    yield* GU.fetch(gitopts);

    // Checking if branch already exists on remote and checkout
    logger.debug('Checking if branch "'+puppetfileBranchName+'" exists on remote');
    var branchExist = yield* GU.branchExist(puppetfileBranchName, gitopts);

    if (branchExist) {
      /*
        If changes from the 'production' branch were merged into our 'feature' branch,
        we need to tell r10k to update the whole environment. Otherwise, we'll simply update
        the module in the 'feature' environment.
      */
      fullDeploymentNeeded = yield* GU.checkoutExisting(puppetfileBranchName, gitopts);
    }
    else {
      // This case should never happen except when someone manually messed up with your Puppetfile
      yield* GU.checkoutNew(puppetfileBranchName, gitopts);

      // If the 'feature' branch doesn't exist on remote, we'll have to deploy the entire 'feature' environment
      fullDeploymentNeeded = commitNeeded = true;
    }

    // We update the reference for the module in the Puppetfile
    var content = yield fse.readFile(pfile, { encoding: 'utf-8' });
    // The following return an array with capturing groups if regex matches
    var moduleDefined = module_regex.exec(content);

    if (!moduleDefined) {

      // This module is not defined in Puppetfile so we need to build the string that will be appended to the Puppetfile
      logger.info('Module '+moduleName+' is not yet referenced in Puppetfile. We need to update it.');

      new_content = content+'\nmod "'+moduleName+'",\n  :git => "'+repoUrl+'",\n  :ref => "'+branchName+'"\n';
      yield fse.writeFile(pfile, new_content, { encoding: 'utf-8' });

      logger.info('New module '+moduleName+' successfully added to Puppetfile');

      commitNeeded = true;

    }
    else {

      /*
        Module exists in Puppetfile so ref should already be pointing to "feature" branch as it's a "modify" event.
        But if it's not the case for some reason, we have to update ref accordingly like we do in the "create" event.
      */

      // moduleDefined[2] contains the name of the ref present in the Puppetfile
      if ((moduleDefined[2] !== puppetfileBranchName && moduleDefined[2] !== 'production')) {

        logger.debug('Reference of module '+moduleName+' is not pointing to branch '+puppetfileBranchName+' nor production, for some reason. Updating it');
        new_content = content.replace(module_regex, '$1'+branchName+'$3');
        logger.debug(new_content);

        yield fse.writeFile(pfile, new_content, { encoding: 'utf-8' });
        logger.debug('Puppetfile updated');

        commitNeeded = true;

      }
    }

    /*
      Push only if needed, that is:
        - when the module were not defined in the Puppetfile for the current branch
        - or when there were changes merged from the 'production' branch to the 'feature' branch
        - or when the module ref was updated (see above)
        - or when both occured
    */

    if (commitNeeded) {

      logger.debug('Branch '+puppetfileBranchName+' has been updated. Commit required');

      // Commiting changes
      yield* GU.commit(moduleName, puppetfileBranchName, gitopts);

    }

    if (commitNeeded || fullDeploymentNeeded) {

      // Pushing changes to remote
      yield* GU.push(puppetfileBranchName, gitopts);

    }

    /*
      Fully deploy environment with r10k if there were changes merged from the 'production' branch.
      Otherwise simply update the module in the 'feature' environment
    */
    if (fullDeploymentNeeded) {
      // r10k deploy environment <feature_env> --puppetfile
      logger.info('Deploy all modules in environment '+puppetfileBranchName+' using r10k');
      rundeck_data.type = 'deploy_env';
    }
    else {
      // r10k deploy module -e <feature_env> <module>
      logger.info('Update module '+moduleName+' in environment '+puppetfileBranchName+' using r10k');
      rundeck_data.type = 'deploy_mod';
    }

    // Launch Rundeck job
    var rd_job_status = yield* RD.runJob(rundeck_data);

    // Removing temp directory
    logger.debug('Removing temp dir: '+gitdir);
    yield fse.remove(gitdir);

    logger.info('Processing branch '+puppetfileBranchName+' of module '+moduleName+' '+rd_job_status);

    // Return the kue "done" callback with null to indicate a successful job
    return cbk(null);

  } catch(err) {

    // The working directory is not changed when a git command fails, we need explicitely change it
    process.chdir(basedir);

    // Remove temp dir even if there's an error so we save disk space
    yield fse.remove(gitdir);

    // Return the kue "done" callback with the error to indicate a failed job
    return cbk(err);

  }
};

module.exports = {
  runModify: runModify
};
