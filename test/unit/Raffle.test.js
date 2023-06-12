const { network, getNamedAccounts, deployments, ethers } = require("hardhat");
const { developmentChains, networkConfig } = require("../../helper-hardhat-config");
const { assert, expect } = require("chai");

!developmentChains.includes(network.name)
    ? describe.skip
    : describe("Raffle", async function () {
          let raffle, vrfCoordinatorV2Mock, raffleEntranceFee, deployer, interval;
          const chainId = network.config.chainId;

          beforeEach(async function () {
              deployer = (await getNamedAccounts()).deployer;
              await deployments.fixture(["all"]);
              raffle = await ethers.getContract("Raffle", deployer);
              vrfCoordinatorV2Mock = await ethers.getContract("VRFCoordinatorV2Mock", deployer);
              raffleEntranceFee = await raffle.getEntranceFee();
              interval = await raffle.getInterval();
          });

          describe("constructor", function () {
              it("initializes the raffle correctly", async function () {
                  const raffleState = await raffle.getRaffleState();
                  assert.equal(raffleState.toString(), "0");
                  assert.equal(interval.toString(), networkConfig[chainId]["interval"]);
              });
          });

          describe("enter Raffle", function () {
              it("reverts when you don't pay enough", async function () {
                  await expect(raffle.enterRaffle()).to.be.revertedWith("Raffle__NotEnoughFee");
              });
              it("records players when they enter", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee });
                  const playerFromContract = await raffle.getPlayer(0);
                  assert.equal(playerFromContract, deployer);
              });
              it("emits events on enter", async function () {
                  await expect(raffle.enterRaffle({ value: raffleEntranceFee })).to.emit(
                      raffle,
                      "RaffleEnter"
                  );
              });
              //   failed test
              it("doesn't allow entrance when raffle is calculating", async () => {
                  await raffle.enterRaffle({ value: raffleEntranceFee });
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1]);
                  await network.provider.request({ method: "evm_mine", params: [] });
                  // we pretend to be a keeper for a second
                  await raffle.performUpkeep([]); // changes the state to calculating for our comparison below
                  await expect(raffle.enterRaffle({ value: raffleEntranceFee })).to.be.revertedWith(
                      // is reverted as raffle is calculating
                      "Raffle__RaffleNotOpen"
                  );
              });
          });

          describe("checkUpKeep", function () {
              it("returns false if people haven't sent ETH", async function () {
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1]);
                  await network.provider.send("evm_mine", []);
                  const { upkeepNeeded } = await raffle.callStatic.checkUpkeep([]);
                  assert(!upkeepNeeded);
              });
              //   failed test
              it("retuns false if raffle isn't open ", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee });
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1]);
                  await network.provider.send("evm_mine", []);
                  await raffle.performUpkeep("0x");
                  const raffleState = await raffle.getRaffleState();
                  const { upkeepNeeded } = raffle.callStatic.checkUpkeep([]);
                  assert.equal(raffleState.toString(), "1");
                  assert.equal(upkeepNeeded, false);
              });
              //   failed test
              it("retuns false if enough time has passed ", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee });
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1]);
                  await network.provider.send("evm_mine", []);
                  const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x");
                  assert(!upkeepNeeded);
              });

              it("retuns true if enough time has passed ", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee });
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1]);
                  await network.provider.send("evm_mine", []);
                  const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x");
                  assert(upkeepNeeded);
              });
          });

          describe("performUpkeep", function () {
              //   failed test
              it("it can only run if checkUpkeep is true", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee });
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1]);
                  await network.provider.send("evm_mine", []);
                  const tx = await raffle.performUpkeep([]);
                  assert(tx);
              });

              it("reverts when checkUpkeep is false", async function () {
                  await expect(raffle.performUpkeep([])).to.be.revertedWith(
                      `Raffle__UpkeepNotNeeded()`
                  );
              });

              //   failed test
              it("updates the raffle state, emits an event & calls the vrf coordinator", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee });
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1]);
                  await network.provider.send("evm_mine", []);
                  const txResponse = await raffle.performUpkeep([]);
                  const txReceipt = await txResponse.wait(1);
                  const requestId = txReceipt.events[1].args.requestId;
                  const raffleState = await raffle.getRaffleState();
                  assert(requestId.toNumber() > 0);
                  assert(raffleState == 1);
              });
          });

          describe("fulfillRandomWords", function () {
              beforeEach(async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee });
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1]);
                  await network.provider.send("evm_mine", []);
              });
              it("can only be called after performUpkeep", async function () {
                  await expect(
                      vrfCoordinatorV2Mock.fulfillRandomWords(0, raffle.address)
                  ).to.be.revertedWith("nonexistent request");
                  await expect(
                      vrfCoordinatorV2Mock.fulfillRandomWords(1, raffle.address)
                  ).to.be.revertedWith("nonexistent request");
              });
              //   A very big test
              it("picks a winner, resets the lottery and sends money", async function () {
                  const additionalEntrants = 3;
                  const startingAccountIndex = 1;
                  const accounts = await ethers.getSigners();
                  for (
                      let i = startingAccountIndex;
                      i < startingAccountIndex + additionalEntrants;
                      i++
                  ) {
                      const accountConnectedRaffle = raffle.connect(accounts[i]);
                      await accountConnectedRaffle.enterRaffle({ value: raffleEntranceFee });
                  }
                  const startingTimeStamp = await raffle.getLatestTimeStamp();

                  //   performUpkeep() (mock being the chainlink Keepers)
                  //   fullfillRandomWords (mock being the chainlink VRF)
                  await new Promise(async (resolve, reject) => {
                      raffle.once("WinnerPicked", async () => {
                          console.log("found the event!");
                          try {
                              const recentWinner = await raffle.getRecentWinner();
                              console.log(recentWinner);
                              console.log(accounts[2]);
                              console.log(accounts[0]);
                              console.log(accounts[1]);
                              console.log(accounts[3]);
                              const raffleState = await raffle.getRaffleState();
                              const endingTimeStamp = await raffle.getLatestTimeStamp();
                              const numPlayers = await raffle.getNumOfPlayers();
                              assert.equal(numPlayers.toString(), "0");
                              assert.equal(raffleState.toString(), "0");
                              assert(endingTimeStamp > startingTimeStamp);
                          } catch (err) {
                              reject(e);
                          }
                          resolve();
                      });
                      const tx = await performUpkeep([]);
                      const txReceipt = await tx.wait(1);
                      await vrfCoordinatorV2Mock.fulfillRandomWords(
                          txReceipt.events[1].args.requestId,
                          raffle.address
                      );
                  });
              });
          });
      });
