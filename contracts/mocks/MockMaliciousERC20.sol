// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// 本地单测用的非标准 / 重入 ERC20 替身，不参与部署。
// mode = 1：transferFrom 返回 false（验证 SafeERC20）；
// mode = 3：transfer 时回调 HTLC 的 claim / refund / lock（验证防重入）。
contract MockMaliciousERC20 {
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    uint8 public mode;
    address public target;
    bytes32 public swapId;
    bytes32 public secret;
    uint256 public reenterAttempts;
    uint256 public reenterSuccesses;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        _balances[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function configure(
        uint8 mode_,
        address target_,
        bytes32 swapId_,
        bytes32 secret_
    ) external {
        mode = mode_;
        target = target_;
        swapId = swapId_;
        secret = secret_;
    }

    function balanceOf(address a) external view returns (uint256) {
        return _balances[a];
    }

    function allowance(address o, address s) external view returns (uint256) {
        return _allowances[o][s];
    }

    function approve(address s, uint256 amount) external returns (bool) {
        _allowances[msg.sender][s] = amount;
        emit Approval(msg.sender, s, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(_balances[msg.sender] >= amount, "insufficient balance");
        _balances[msg.sender] -= amount;
        _balances[to] += amount;
        emit Transfer(msg.sender, to, amount);

        if (mode == 3) {
            _try(bytes4(keccak256("claim(bytes32,bytes32)")), abi.encode(swapId, secret));
            _try(bytes4(keccak256("refund(bytes32)")), abi.encode(swapId));
            _try(
                bytes4(keccak256("lock(address,address,uint256,bytes32,uint256)")),
                abi.encode(address(this), msg.sender, amount, bytes32(0), block.timestamp + 3600)
            );
        }
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        require(_balances[from] >= amount, "insufficient balance");
        require(_allowances[from][msg.sender] >= amount, "insufficient allowance");
        _allowances[from][msg.sender] -= amount;
        _balances[from] -= amount;
        _balances[to] += amount;
        emit Transfer(from, to, amount);
        if (mode == 1) return false;
        return true;
    }

    // 忽略内层调用结果：nonReentrant 生效时内层失败被吞掉，外层仍可完成。
    function _try(bytes4 selector, bytes memory params) private {
        reenterAttempts++;
        (bool ok, ) = target.call(abi.encodePacked(selector, params));
        if (ok) reenterSuccesses++;
    }
}
