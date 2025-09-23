// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title YMReceipt
 * @dev Unified ERC1155 receipt for YES.Y / NO.Y across all vaults. Token IDs should match
 *      Polymarket position IDs or a deterministic hash of (CTF, conditionId, indexSet).
 *      Minter control is per-tokenId to bind a specific vault as the sole minter/burner.
 */
contract YMReceipt is ERC1155, Ownable {
    // tokenId => minter (vault) allowed to mint/burn that id
    mapping(uint256 => address) public minterForTokenId;

    event MinterSet(uint256 indexed tokenId, address indexed minter);

    constructor(string memory baseURI, address initialOwner) ERC1155(baseURI) Ownable(initialOwner) {}

    modifier onlyMinter(uint256 tokenId) {
        require(minterForTokenId[tokenId] == msg.sender, "Not authorized minter");
        _;
    }

    function setMinter(uint256 tokenId, address minter) external onlyOwner {
        require(minterForTokenId[tokenId] == address(0), "Minter already set");
        minterForTokenId[tokenId] = minter;
        emit MinterSet(tokenId, minter);
    }

    function setMinters(uint256[] calldata tokenIds, address[] calldata minters) external onlyOwner {
        require(tokenIds.length == minters.length, "Length mismatch");
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 id = tokenIds[i];
            address m = minters[i];
            require(minterForTokenId[id] == address(0), "Minter already set");
            minterForTokenId[id] = m;
            emit MinterSet(id, m);
        }
    }

    function mint(address to, uint256 id, uint256 amount) external onlyMinter(id) {
        _mint(to, id, amount, "");
    }

    function burn(address from, uint256 id, uint256 amount) external onlyMinter(id) {
        _burn(from, id, amount);
    }
}


